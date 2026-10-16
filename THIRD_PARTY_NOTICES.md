# Third-party notices

GachaSimulate includes or uses third-party components that remain under their own licenses:

- `fonts/SourceHanSansSC/OTF/SimplifiedChinese/SourceHanSansSC-*.otf`: SIL Open Font License 1.1. The copyright notice and license text are in [`third_party/licenses/SourceHanSansSC-OFL-1.1.txt`](third_party/licenses/SourceHanSansSC-OFL-1.1.txt).
- `fonts/JetBrainsMono/`: SIL Open Font License 1.1. The copyright notice and license text are in [`third_party/licenses/JetBrainsMono-OFL-1.1.txt`](third_party/licenses/JetBrainsMono-OFL-1.1.txt), with the [upstream authors](third_party/licenses/JetBrainsMono-AUTHORS.txt). Original license and author files are retained in the font directory.
- nlohmann/json 3.11.3, used by the native programs: MIT. The license text is in [`third_party/licenses/nlohmann-json-3.11.3-MIT.txt`](third_party/licenses/nlohmann-json-3.11.3-MIT.txt).
- Production npm dependencies: their package notices and license texts are collected at build time in `THIRD_PARTY_LICENSES.txt` and installed under `resources/licenses/`. The reviewed exception for `victory-vendor@37.3.6` is recorded in [`third_party/licenses/victory-vendor-37.3.6.txt`](third_party/licenses/victory-vendor-37.3.6.txt).
- Electron and Chromium: electron-builder supplies `LICENSE.electron.txt` and `LICENSES.chromium.html` in the packaged application.

FFmpeg and its dependencies are covered by the existing dedicated FFmpeg distribution materials and are not part of the application npm license inventory.
