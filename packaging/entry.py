"""PyInstaller entry point (the package uses relative imports, so it cannot be the script itself)."""

import multiprocessing

from lightsim.__main__ import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
