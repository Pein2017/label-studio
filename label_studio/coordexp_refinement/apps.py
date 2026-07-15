"""Django application boundary for the CoordExp refinement extension."""

from django.apps import AppConfig


class CoordExpRefinementConfig(AppConfig):
    """Register HTTP seams without starting process-local workers."""

    name = 'coordexp_refinement'
