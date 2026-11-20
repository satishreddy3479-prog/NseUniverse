"""A small least-recently-used cache with hit and miss counts, for the per-unit Greeks of a (surface version, expiry, strike, side)."""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Hashable
from dataclasses import dataclass
from typing import Generic, TypeVar

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")


@dataclass(frozen=True)
class CacheStats:
    size: int
    max_size: int
    hits: int
    misses: int
    evictions: int


class LruCache(Generic[K, V]):
    """Bounded mapping that drops the least recently used entry when full. Values must be immutable (they are shared between callers)."""

    def __init__(self, max_size: int) -> None:
        if max_size < 1:
            raise ValueError("max_size must be at least 1")
        self.max_size = max_size
        self._d: OrderedDict[K, V] = OrderedDict()
        self._hits = self._misses = self._evictions = 0

    def get(self, key: K) -> V | None:
        if key in self._d:
            self._d.move_to_end(key)
            self._hits += 1
            return self._d[key]
        self._misses += 1
        return None

    def put(self, key: K, value: V) -> None:
        self._d[key] = value
        self._d.move_to_end(key)
        while len(self._d) > self.max_size:
            self._d.popitem(last=False)
            self._evictions += 1

    def __len__(self) -> int:
        return len(self._d)

    def stats(self) -> CacheStats:
        return CacheStats(len(self._d), self.max_size, self._hits, self._misses, self._evictions)
