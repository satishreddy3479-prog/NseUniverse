"""Advanced Greeks and What-If analytics for NIFTY index options (read-only: no orders, no broker calls).

Layers, each importing only the ones before it: ``pricing`` (Black-76) -> ``greeks`` -> ``ivsurface`` -> ``whatif`` -> ``portfolio`` -> ``service`` / API.
"""
