Drift custom installer v2 - how to apply
1. Delete the old installer\ folder from the previous version (no longer used).
2. Unzip this archive into the Drift repo root (adds src\setup\, electron-builder.setup.json, scripts\build_setup.bat).
3. Run scripts\build_setup.bat  ->  dist-setup\Drift-Setup.exe
Test the UI without building:  npx electron . --setup
