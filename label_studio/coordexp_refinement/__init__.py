"""Label Studio bridge for the CoordExp COCO refinement runtime.

Keep this package initializer free of model-backed imports: Django imports app
packages before the application registry is ready. Consumers import concrete
bridges from ``coordexp_refinement.catalog`` after ``django.setup()``.
"""

__all__: list[str] = []
