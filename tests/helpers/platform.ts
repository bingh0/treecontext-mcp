import { describe, it } from 'vitest'

/**
 * POSIX-only gate for claims Windows genuinely cannot answer: file-mode and
 * symlink assertions (Node on Windows reports `mode & 0o777 === 0o666`
 * regardless of chmod, because NTFS has no POSIX permission bits), and tests
 * that execute an emitted /bin/bash script or a version-manager layout Windows
 * does not use. Skip those rather than weaken the assertion everywhere.
 *
 * Use this rather than an `if (process.platform === 'win32') return` inside the
 * test body. An early return reports a PASS, so a claim Windows never checked
 * looks identical to one it satisfied — which is how three win32 gates went
 * five releases being read as coverage. A skip is visible in the count and has
 * to be justified; a silent pass is not and does not.
 */
const isWin = process.platform === 'win32'

// Explicit annotations: the inferred type reaches names inside vitest's
// runner bundle that the declaration emitter cannot spell (TS4023). The
// `.skip` branch's type is the annotation because it is the narrower of the
// two — both `describe` and `describe.skip` satisfy it.
export const describePosix: typeof describe.skip = isWin ? describe.skip : describe
export const itPosix: typeof it.skip = isWin ? it.skip : it
