"""CLI composition helpers for product-oriented commands."""

from .parser import ProductCommandDefaults, ProductCommandHandlers, register_product_command_parsers

__all__ = [
    "ProductCommandDefaults",
    "ProductCommandHandlers",
    "register_product_command_parsers",
]

