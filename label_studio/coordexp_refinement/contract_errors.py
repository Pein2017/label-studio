"""Small contract-error vocabulary for coordexp-infras."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any


class CoordExpError(Exception):
    """Base class for coordexp-infras contract failures."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        context: Mapping[str, Any] | None = None,
        cause: BaseException | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.context = dict(context or {})
        self.cause = cause
        super().__init__(self._format_message())
        if cause is not None:
            self.__cause__ = cause

    def _format_message(self) -> str:
        prefix = f"{type(self).__name__}[{self.code}]: {self.message}"
        if not self.context:
            return prefix
        context_text = json.dumps(
            self.context,
            ensure_ascii=True,
            sort_keys=True,
            default=str,
        )
        return f"{prefix} | context: {context_text}"


class ConfigContractError(CoordExpError):
    """Raised when authored or resolved config violates the contract."""


class DataContractError(CoordExpError):
    """Raised when raw or validated data violates the contract."""


class TemplateContractError(CoordExpError):
    """Raised when template rendering or spans violate the contract."""


class EncodingContractError(CoordExpError):
    """Raised when token/image encoding violates the contract."""


class PackingContractError(CoordExpError):
    """Raised when packed sequence construction violates the contract."""


class QwenForwardContractError(CoordExpError):
    """Raised when Qwen setup or forward inputs/outputs violate the contract."""


class LossContractError(CoordExpError):
    """Raised when supervision or loss computation violates the contract."""


class RuntimeContractError(CoordExpError):
    """Raised when runtime, distributed, or artifact mechanics violate the contract."""


class ArtifactContractError(CoordExpError):
    """Raised when run artifacts, manifests, or metric records violate the contract."""
