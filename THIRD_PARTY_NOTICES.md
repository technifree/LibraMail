# Third-party notices

## Mailbox Synchroniseur

The **IMAP migration** feature in LibraMail is inspired by and adapts design and implementation concepts from the open-source project **Mailbox Synchroniseur**:

- Source: https://github.com/Othman-Benbrahim/Mailbox-Synchroniseur
- License: MIT
- Copyright (c) 2026 Mailbox Synchroniseur contributors

LibraMail's integration is a separate Node.js/Neutralino implementation and does not embed the original PySide application.

MIT License

Copyright (c) 2026 Mailbox Synchroniseur contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## imapsync

LibraMail uses **imapsync** for the IMAP migration feature. The optional
standalone migration engine is packaged into full Linux and Windows releases
from the upstream imapsync 2.314 distribution after SHA-256 verification.

- Author: Gilles Lamiral
- Project: https://imapsync.lamiral.info/
- License: NOLIMIT Public License (NLPL)
- The exact upstream LICENSE is included at `runtime/imapsync/LICENSE`.

Source archives and build logs are managed by the GitHub Actions build. The
Windows archive checksum must be approved as a repository variable in advance.
