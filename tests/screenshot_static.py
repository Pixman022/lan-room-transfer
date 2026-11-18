"""Compatibility entrypoint for offline UI screenshots and interaction checks."""
from pathlib import Path
from runpy import run_path

run_path(str(Path(__file__).with_name('offline_room_ui.py')), run_name='__main__')
