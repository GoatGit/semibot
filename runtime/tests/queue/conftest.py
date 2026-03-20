"""Shared fixtures and module loading for queue tests."""

import importlib.util
import sys
from pathlib import Path

# Direct module loading to avoid 'queue' name conflict with stdlib
_src_path = Path(__file__).parent.parent.parent / "src"


def _load_module(name, subpath):
    """Load a module directly from file path."""
    spec = importlib.util.spec_from_file_location(name, _src_path / subpath)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# Load constants first (dependency)
if "src.constants.config" not in sys.modules:
    _config = _load_module("src.constants.config", "constants/config.py")
    # Create parent module
    if "src.constants" not in sys.modules:
        _constants_mod = type(sys)("src.constants")
        _constants_mod.config = _config
        sys.modules["src.constants"] = _constants_mod

# Load queue modules
if "src.queue.producer" not in sys.modules:
    _producer = _load_module("src.queue.producer", "queue/producer.py")
else:
    _producer = sys.modules["src.queue.producer"]

if "src.queue.consumer" not in sys.modules:
    _consumer = _load_module("src.queue.consumer", "queue/consumer.py")
else:
    _consumer = sys.modules["src.queue.consumer"]

# Export classes
TaskMessage = _consumer.TaskMessage
TaskConsumer = _consumer.TaskConsumer
run_worker = _consumer.run_worker

TaskPayload = _producer.TaskPayload
TaskProducer = _producer.TaskProducer
QueueFullError = _producer.QueueFullError
enqueue_task = _producer.enqueue_task
