"""Public generation entry point: complete populations and career examples."""
from .league import make_showcase


def generate(panel, output, seed=20261030, replicates=100):
    if replicates < 3:
        raise ValueError('At least three seasons are required for the showcase')
    return make_showcase(panel, output, replicates=replicates, seed=seed)
