"""Explicit apply/attest command for the CoordExp refinement bootstrap."""

from __future__ import annotations

import json
from pathlib import Path

from coordexp_refinement.bootstrap import (
    DjangoRefinementProjectAdapter,
    build_desired_projects,
)
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from organizations.models import Organization


class Command(BaseCommand):
    help = (
        "Plan then explicitly apply or attest the fixed CoordExp train/val "
        "Label Studio refinement projects. This command never deletes or cleans up rows."
    )

    def add_arguments(self, parser):
        parser.add_argument("mode", choices=("apply", "attest"))
        parser.add_argument("--repo-root", required=True, type=Path)
        parser.add_argument("--operator-user-id", required=True, type=int)
        parser.add_argument("--organization-id", required=True, type=int)
        parser.add_argument("--chunk-size", type=int, default=500)

    def handle(self, *args, **options):
        try:
            user = get_user_model().objects.get(pk=options["operator_user_id"])
            organization = Organization.objects.get(pk=options["organization_id"])
            adapter = DjangoRefinementProjectAdapter(
                repo_root=options["repo_root"],
                operator_user=user,
                organization=organization,
                chunk_size=options["chunk_size"],
            )
            desired = build_desired_projects(
                options["repo_root"], vendor_revision=adapter.vendor_revision
            )
            contract = adapter.contract
            plan = contract.plan_instance_bootstrap(desired, adapter)
            before = {
                action.project.split.value: action.action.value
                for action in plan.projects
            }
            if options["mode"] == "apply":
                adapter.apply(plan)
                verified_plan = contract.plan_instance_bootstrap(desired, adapter)
                after = {
                    action.project.split.value: action.action.value
                    for action in verified_plan.projects
                }
                if set(after.values()) != {"reuse"}:
                    raise CommandError(f"post-apply attestation is not REUSE: {after}")
            else:
                after = before
            self.stdout.write(
                json.dumps(
                    {
                        "mode": options["mode"],
                        "before": before,
                        "after": after,
                        "runtime_manifest": str(adapter.runtime_manifest_path),
                        "vendor_revision": adapter.vendor_revision,
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
        except (get_user_model().DoesNotExist, Organization.DoesNotExist) as exc:
            raise CommandError("operator user or organization does not exist") from exc
        except CommandError:
            raise
        except Exception as exc:
            raise CommandError(str(exc)) from exc
