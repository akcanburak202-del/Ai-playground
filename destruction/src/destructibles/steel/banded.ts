/**
 * Symmetric positive-definite banded matrix with in-place Cholesky factorisation (LLᵀ) and solve.
 * Storage: row i keeps columns i − bw … i in `a[i·(bw+1) + (j − i + bw)]`. Cost O(n·bw²).
 * Used by the beam solver, whose constraint coupling matrix J W Jᵀ is banded when constraints
 * are ordered by node.
 */
export class BandedSPD {
  n = 0;
  bw = 0;
  a = new Float64Array(0);

  resize(n: number, bw: number): void {
    this.n = n;
    this.bw = bw;
    const need = n * (bw + 1);
    if (this.a.length < need) this.a = new Float64Array(need);
    else this.a.fill(0, 0, need);
  }

  /** Add v to A[i][j] (and implicitly A[j][i]); requires |i − j| ≤ bw. */
  add(i: number, j: number, v: number): void {
    if (j > i) {
      const t = i;
      i = j;
      j = t;
    }
    this.a[i * (this.bw + 1) + (j - i + this.bw)]! += v;
  }

  get(i: number, j: number): number {
    if (j > i) {
      const t = i;
      i = j;
      j = t;
    }
    if (i - j > this.bw) return 0;
    return this.a[i * (this.bw + 1) + (j - i + this.bw)]!;
  }

  /** Replace row/column i by the identity (a fixed unknown). */
  pin(i: number): void {
    const w = this.bw + 1;
    for (let j = Math.max(0, i - this.bw); j <= i; j++) this.a[i * w + (j - i + this.bw)] = j === i ? 1 : 0;
    for (let r = i + 1; r <= Math.min(this.n - 1, i + this.bw); r++) this.a[r * w + (i - r + this.bw)] = 0;
  }

  /** In-place Cholesky. Returns false if the matrix is not positive definite. */
  factor(): boolean {
    const n = this.n, bw = this.bw, w = bw + 1, a = this.a;
    for (let i = 0; i < n; i++) {
      const j0 = Math.max(0, i - bw);
      for (let j = j0; j <= i; j++) {
        let s = a[i * w + (j - i + bw)]!;
        const k0 = Math.max(j0, j - bw);
        for (let k = k0; k < j; k++) s -= a[i * w + (k - i + bw)]! * a[j * w + (k - j + bw)]!;
        if (j === i) {
          if (!(s > 0)) return false;
          a[i * w + bw] = Math.sqrt(s);
        } else a[i * w + (j - i + bw)] = s / a[j * w + bw]!;
      }
    }
    return true;
  }

  /** Solve (LLᵀ) x = b in place (b becomes x). */
  solve(b: Float64Array): void {
    const n = this.n, bw = this.bw, w = bw + 1, a = this.a;
    for (let i = 0; i < n; i++) {
      let s = b[i]!;
      for (let k = Math.max(0, i - bw); k < i; k++) s -= a[i * w + (k - i + bw)]! * b[k]!;
      b[i] = s / a[i * w + bw]!;
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i]!;
      for (let k = i + 1; k <= Math.min(n - 1, i + bw); k++) s -= a[k * w + (i - k + bw)]! * b[k]!;
      b[i] = s / a[i * w + bw]!;
    }
  }
}
