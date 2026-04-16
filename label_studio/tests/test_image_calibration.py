from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image
from rest_framework.exceptions import ValidationError
from tasks.image_calibration import calibrate_annotation_result_for_local_files, calibrate_exported_annotation_result_for_local_files
from tasks.result_normalization import build_normalized_annotation_payload, calibrate_result_payload
from tasks.serializers import sanitize_image_status_result


def test_calibrate_result_payload_swaps_dimensions_for_rotated_vector_and_relation_groups():
    result = [
        {
            'id': 'box-1',
            'type': 'rectanglelabels',
            'original_width': 750,
            'original_height': 1000,
            'image_rotation': 90,
            'value': {
                'x': 10,
                'y': 20,
                'width': 20,
                'height': 10,
                'rectanglelabels': ['端口/矩形'],
            },
        },
        {
            'id': 'line-1',
            'type': 'vectorlabels',
            'original_width': 750,
            'original_height': 1000,
            'image_rotation': 90,
            'value': {
                'closed': False,
                'vertices': [
                    {'x': 10, 'y': 20, 'id': 'p1', 'isBezier': False},
                    {'x': 40, 'y': 60, 'id': 'p2', 'prevPointId': 'p1', 'isBezier': False},
                ],
                'vectorlabels': ['尾纤连接处'],
            },
        },
        {
            'type': 'relation',
            'from_id': 'box-1',
            'to_id': 'line-1',
            'labels': ['配对'],
        },
    ]

    calibrated = calibrate_result_payload(result, strict=True)

    assert calibrated[0]['original_width'] == 1000.0
    assert calibrated[0]['original_height'] == 750.0
    assert calibrated[0]['image_rotation'] == 0
    assert calibrated[0]['value']['x'] == pytest.approx(70.0)
    assert calibrated[0]['value']['y'] == pytest.approx(10.0)
    assert calibrated[0]['value']['width'] == pytest.approx(10.0)
    assert calibrated[0]['value']['height'] == pytest.approx(20.0)

    normalized_regions, groups, filtered_result = build_normalized_annotation_payload(result)

    assert [region['kind'] for region in normalized_regions] == ['rect', 'line']
    assert normalized_regions[0]['points'] == pytest.approx([700.0, 75.0, 800.0, 225.0])
    assert normalized_regions[1]['points'] == pytest.approx([800.0, 75.0, 400.0, 300.0])
    assert groups == [[1, 2]]
    assert all(item.get('type') != 'relation' for item in filtered_result)


def test_calibrate_annotation_result_for_local_files_rotates_image_in_place(tmp_path, monkeypatch):
    image_path = tmp_path / 'portrait.png'
    Image.new('RGB', (2, 4), 'red').save(image_path)

    result = [
        {
            'id': 'rect-1',
            'type': 'rectanglelabels',
            'original_width': 2,
            'original_height': 4,
            'image_rotation': 90,
            'value': {
                'x': 25,
                'y': 50,
                'width': 25,
                'height': 25,
                'rectanglelabels': ['端口/矩形'],
            },
        }
    ]

    monkeypatch.setattr('tasks.image_calibration._resolve_task_local_image_path', lambda task, item_index: image_path)

    calibrated = calibrate_annotation_result_for_local_files(SimpleNamespace(project_id=1, data={}), result)

    with Image.open(image_path) as rotated:
        assert rotated.size == (4, 2)

    assert calibrated[0]['original_width'] == 4.0
    assert calibrated[0]['original_height'] == 2.0
    assert calibrated[0]['image_rotation'] == 0
    assert calibrated[0]['value']['x'] == pytest.approx(25.0)
    assert calibrated[0]['value']['y'] == pytest.approx(25.0)


def test_calibrate_annotation_result_for_local_files_rejects_mixed_rotations(tmp_path, monkeypatch):
    image_path = tmp_path / 'portrait.png'
    Image.new('RGB', (2, 4), 'red').save(image_path)

    result = [
        {
            'id': 'rect-1',
            'type': 'rectanglelabels',
            'original_width': 2,
            'original_height': 4,
            'image_rotation': 0,
            'value': {'x': 10, 'y': 10, 'width': 10, 'height': 10},
        },
        {
            'id': 'rect-2',
            'type': 'rectanglelabels',
            'original_width': 2,
            'original_height': 4,
            'image_rotation': 90,
            'value': {'x': 20, 'y': 20, 'width': 10, 'height': 10},
        },
    ]

    monkeypatch.setattr('tasks.image_calibration._resolve_task_local_image_path', lambda task, item_index: image_path)

    with pytest.raises(ValidationError):
        calibrate_annotation_result_for_local_files(SimpleNamespace(project_id=1, data={}), result)


def test_calibrate_annotation_result_for_local_files_refreshes_local_image_url(tmp_path, monkeypatch):
    image_path = tmp_path / 'portrait.png'
    Image.new('RGB', (2, 4), 'red').save(image_path)

    class FakeTask:
        def __init__(self):
            self.project_id = 1
            self.data = {'image': '/data/local-files/?d=pigtail-images/portrait.png'}
            self.saved_update_fields = None

        def save(self, update_fields=None):
            self.saved_update_fields = update_fields

    task = FakeTask()
    result = [
        {
            'id': 'rect-1',
            'type': 'rectanglelabels',
            'original_width': 2,
            'original_height': 4,
            'image_rotation': 90,
            'value': {'x': 25, 'y': 50, 'width': 25, 'height': 25},
        }
    ]

    monkeypatch.setattr('tasks.image_calibration._resolve_task_local_image_path', lambda task, item_index: image_path)

    calibrate_annotation_result_for_local_files(task, result)

    assert task.data['image'].startswith('/data/local-files/?d=pigtail-images%2Fportrait.png')
    assert '&v=' in task.data['image']
    assert task.saved_update_fields == ['data', 'updated_at']


def test_calibrate_exported_annotation_result_for_local_files_uses_exif_orientation(tmp_path, monkeypatch):
    image_path = tmp_path / 'portrait.jpg'
    image = Image.new('RGB', (422, 1000), 'red')
    exif = image.getexif()
    exif[274] = 6
    image.save(image_path, exif=exif)

    result = [
        {
            'id': 'rect-1',
            'type': 'rectanglelabels',
            'original_width': 1000,
            'original_height': 422,
            'image_rotation': 0,
            'value': {
                'x': 10,
                'y': 20,
                'width': 30,
                'height': 10,
                'rectanglelabels': ['端口/矩形'],
            },
        }
    ]

    monkeypatch.setattr('tasks.image_calibration._resolve_task_local_image_path', lambda task, item_index: image_path)

    calibrated = calibrate_exported_annotation_result_for_local_files(SimpleNamespace(project_id=1, data={}), result)

    assert calibrated[0]['original_width'] == 422.0
    assert calibrated[0]['original_height'] == 1000.0
    assert calibrated[0]['image_rotation'] == 0
    assert calibrated[0]['value']['x'] == pytest.approx(20.0)
    assert calibrated[0]['value']['y'] == pytest.approx(60.0)
    assert calibrated[0]['value']['width'] == pytest.approx(10.0)
    assert calibrated[0]['value']['height'] == pytest.approx(30.0)


def test_sanitize_image_status_result_keeps_only_global_flags_for_irrelevant_image():
    result = [
        {
            'id': 'status-1',
            'type': 'choices',
            'from_name': 'image_status',
            'value': {'choices': ['无关图片']},
        },
        {
            'id': 'reason-1',
            'type': 'choices',
            'from_name': 'image_skip_reason',
            'value': {'choices': ['不清晰']},
        },
        {
            'id': 'rect-1',
            'type': 'rectanglelabels',
            'from_name': 'rect',
            'value': {'x': 10, 'y': 10, 'width': 20, 'height': 20},
        },
        {
            'type': 'relation',
            'from_id': 'rect-1',
            'to_id': 'line-1',
            'labels': ['配对'],
        },
    ]

    cleaned = sanitize_image_status_result(result)

    assert [item['from_name'] for item in cleaned] == ['image_status', 'image_skip_reason']


def test_sanitize_image_status_result_drops_stale_skip_reason_for_normal_image():
    result = [
        {
            'id': 'status-1',
            'type': 'choices',
            'from_name': 'image_status',
            'value': {'choices': ['正常']},
        },
        {
            'id': 'reason-1',
            'type': 'choices',
            'from_name': 'image_skip_reason',
            'value': {'choices': ['不清晰']},
        },
        {
            'id': 'rect-1',
            'type': 'rectanglelabels',
            'from_name': 'rect',
            'value': {'x': 10, 'y': 10, 'width': 20, 'height': 20},
        },
    ]

    cleaned = sanitize_image_status_result(result)

    assert [item['from_name'] for item in cleaned] == ['image_status', 'rect']


def test_sanitize_image_status_result_injects_normal_status_when_missing():
    result = [
        {
            'id': 'rect-1',
            'type': 'rectanglelabels',
            'from_name': 'rect',
            'value': {'x': 10, 'y': 10, 'width': 20, 'height': 20},
        },
    ]

    cleaned = sanitize_image_status_result(result)

    assert cleaned[0]['from_name'] == 'image_status'
    assert cleaned[0]['type'] == 'choices'
    assert cleaned[0]['value']['choices'] == ['正常']
    assert cleaned[1]['from_name'] == 'rect'
