"""OpenAI-compatible FastAPI server backed by a LoRA-adapted base model."""

from .app import create_app
from .schemas import (
    ChatMessage,
    ChatCompletionRequest,
    ChatCompletionChoice,
    ChatCompletionResponse,
    CompletionRequest,
    CompletionResponse,
    CompletionChoice,
    Usage,
    ModelCard,
    ModelList,
)
from .auth import verify_api_key
from .model_handle import ModelHandle, MockHandle, ModelHandleError, load_handle

__all__ = [
    "create_app",
    "ChatMessage",
    "ChatCompletionRequest",
    "ChatCompletionChoice",
    "ChatCompletionResponse",
    "CompletionRequest",
    "CompletionResponse",
    "CompletionChoice",
    "Usage",
    "ModelCard",
    "ModelList",
    "verify_api_key",
    "ModelHandle",
    "MockHandle",
    "ModelHandleError",
    "load_handle",
]
