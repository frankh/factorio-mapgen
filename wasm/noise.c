// WebAssembly (with SIMD) kernels for noise.js and
// preview.js, mostly four points at a time. Each gives the same bits as the
// JS it replaces:
//
// - noise and noise_rows: the corner sums of the game's Noise::noise
//   (noiseKernel in noise.js) and the octave coordinates feeding it
//   (noiseSum), noise_rows for points laid out in rows;
// - element-wise operators over the program's buffers, which noise.js keeps
//   in this module's memory (add_vv(dst, a, b, n), add_vs(dst, a, s, n),
//   add_sv(dst, s, b, n), ...). JS computes these in double precision and
//   rounds to single; for + - * / and sqrt that is the same as computing in
//   single precision, so these work in single precision, except mod, which
//   works in double as the JS does;
// - pow with a constant exponent, as gamePow;
// - exec: runs of those operators in one call, as a program's plan has them;
// - chunk_tiles and chunk_draws: preview.js's tile choice and entity draws;
// - voronoi: voronoiSearch and its manhattan and chebyshev pyramids;
// - spot_rows and spot_points: spot noise's cones.
//
// n is always a multiple of 4: buffers are allocated in whole vectors.
#include <wasm_simd128.h>
#include <stdint.h>

#define CAP 4096
#define EXPORT(name) __attribute__((export_name(name)))

static float SX[CAP], SY[CAP], SO[CAP], SA[CAP], SOX[CAP], SOY[CAP];  // staging for buffers outside this memory
static float G[512];                       // gradient (x, y) pairs, shuffled for the seed
static unsigned char T1[256], T2[256];     // row (y) and column (x) hashes

EXPORT("sx") float *sx_(void) { return SX; }
EXPORT("sy") float *sy_(void) { return SY; }
EXPORT("so") float *so_(void) { return SO; }
EXPORT("sa") float *sa_(void) { return SA; }
EXPORT("sox") float *sox_(void) { return SOX; }
EXPORT("soy") float *soy_(void) { return SOY; }
EXPORT("g") float *g_(void) { return G; }
EXPORT("t1") unsigned char *t1_(void) { return T1; }
EXPORT("t2") unsigned char *t2_(void) { return T2; }
EXPORT("cap") int cap_(void) { return CAP; }

#define L(v, j) wasm_i32x4_extract_lane(v, j)

// The compiler turns fill loops into memset, and there is no libc.
__attribute__((no_builtin)) void *memset(void *d, int c, unsigned long n) {
  unsigned char *p = d;
  while (n--) *p++ = (unsigned char)c;
  return d;
}

// ------------------------------------------------------------------ noise

// The gradients of four corners: x components in *gx, y components in *gy.
static inline void grads(int k0, int k1, int k2, int k3, v128_t *gx, v128_t *gy) {
  v128_t a = wasm_v128_load64_zero(&G[2 * k0]), b = wasm_v128_load64_zero(&G[2 * k1]);
  v128_t c = wasm_v128_load64_zero(&G[2 * k2]), d = wasm_v128_load64_zero(&G[2 * k3]);
  v128_t ab = wasm_i64x2_shuffle(a, b, 0, 2), cd = wasm_i64x2_shuffle(c, d, 0, 2);
  *gx = wasm_i32x4_shuffle(ab, cd, 0, 2, 4, 6);
  *gy = wasm_i32x4_shuffle(ab, cd, 1, 3, 5, 7);
}

static inline v128_t corner(v128_t dx, v128_t dy, v128_t q, v128_t k) {
  v128_t gx, gy;
  grads(L(k, 0), L(k, 1), L(k, 2), L(k, 3), &gx, &gy);
  v128_t dot = wasm_f32x4_add(wasm_f32x4_mul(dx, gx), wasm_f32x4_mul(dy, gy));
  return wasm_f32x4_mul(dot, wasm_f32x4_mul(wasm_f32x4_mul(q, q), q));
}

// The same with all four gradients one corner's (the four points in one
// lattice cell).
static inline v128_t cornerS(v128_t dx, v128_t dy, v128_t q, int k) {
  v128_t dot = wasm_f32x4_add(wasm_f32x4_mul(dx, wasm_f32x4_splat(G[2 * k])), wasm_f32x4_mul(dy, wasm_f32x4_splat(G[2 * k + 1])));
  return wasm_f32x4_mul(dot, wasm_f32x4_mul(wasm_f32x4_mul(q, q), q));
}

// f + c, the add in double precision, rounded back to single.
static inline v128_t addd(v128_t f, double c) {
  v128_t C = wasm_f64x2_splat(c);
  v128_t lo = wasm_f64x2_add(wasm_f64x2_promote_low_f32x4(f), C);
  v128_t hi = wasm_f64x2_add(wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(f, f, 1, 1)), C);
  return wasm_i64x2_shuffle(wasm_f32x4_demote_f64x2_zero(lo), wasm_f32x4_demote_f64x2_zero(hi), 0, 2);
}

// One octave of noise: out[i] += amp * (the corner sums at point i in
// lattice units), amp being ampv, or ampp[i] when ampp is set.
//
// Points xs/ys go into lattice units by kind (0 point, 1 grid, 2
// multioctave point, 3 multioctave grid; see noiseSum in noise.js), on a grid
// relative to their chunk's corner oxp/oyp[i], or oxs/oys for all of them.
// The grid kinds use the chunk-grid version of q and of the summing order.
EXPORT("noise")
void noise(int n, int kind, float s, float offx, float offy, double c, float st,
           const float *xs, const float *ys, const float *oxp, const float *oyp, float oxs, float oys,
           int seed, float ampv, const float *ampp, float *out) {
  const v128_t SC = wasm_f32x4_splat(s), OFX = wasm_f32x4_splat(offx), OFY = wasm_f32x4_splat(offy), ST = wasm_f32x4_splat(st);
  const v128_t OXS = wasm_f32x4_splat(oxs), OYS = wasm_f32x4_splat(oys);
  const v128_t ONE = wasm_f32x4_splat(1.0f), ZERO = wasm_f32x4_splat(0.0f), M = wasm_i32x4_splat(255), I1 = wasm_i32x4_splat(1);
  const v128_t S = wasm_i32x4_splat(seed), AM = wasm_f32x4_splat(ampv);
  const int grid = kind & 1;
  for (int i = 0; i < n; i += 4) {
    v128_t xv = wasm_v128_load(&xs[i]), yv = wasm_v128_load(&ys[i]);
    v128_t ox = oxp ? wasm_v128_load(&oxp[i]) : OXS, oy = oyp ? wasm_v128_load(&oyp[i]) : OYS;
    if (kind == 0) {
      xv = wasm_f32x4_mul(wasm_f32x4_add(xv, OFX), SC);
      yv = wasm_f32x4_mul(wasm_f32x4_add(yv, OFY), SC);
    } else if (kind == 1) {
      xv = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_sub(xv, ox), wasm_f32x4_add(OFX, ox)), SC);
      yv = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_sub(yv, oy), wasm_f32x4_add(OFY, oy)), SC);
    } else if (kind == 2) {
      xv = addd(wasm_f32x4_mul(xv, SC), c);
      yv = wasm_f32x4_mul(yv, SC);
    } else {
      v128_t oxk = addd(wasm_f32x4_mul(ox, ST), c), oyk = wasm_f32x4_mul(oy, ST);
      xv = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_sub(xv, ox), ST), oxk), SC);
      yv = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_sub(yv, oy), ST), oyk), SC);
    }
    v128_t x0 = wasm_f32x4_floor(xv), y0 = wasm_f32x4_floor(yv);
    v128_t fx = wasm_f32x4_sub(xv, x0), fy = wasm_f32x4_sub(yv, y0);
    v128_t gx = wasm_f32x4_sub(fx, ONE), gy = wasm_f32x4_sub(fy, ONE);
    v128_t fxx = wasm_f32x4_mul(fx, fx), gxx = wasm_f32x4_mul(gx, gx), fyy = wasm_f32x4_mul(fy, fy), gyy = wasm_f32x4_mul(gy, gy);
    v128_t q00, q01, q10, q11;
    if (grid) {
      // q = max((1 - dy^2) - dx^2, 0), as maxps: the value if above 0, else 0
      // (pmax(0, v) is exactly that).
      v128_t e0 = wasm_f32x4_sub(ONE, fyy), e1 = wasm_f32x4_sub(ONE, gyy), v;
      v = wasm_f32x4_sub(e0, fxx); q00 = wasm_f32x4_pmax(ZERO, v);
      v = wasm_f32x4_sub(e0, gxx); q10 = wasm_f32x4_pmax(ZERO, v);
      v = wasm_f32x4_sub(e1, fxx); q01 = wasm_f32x4_pmax(ZERO, v);
      v = wasm_f32x4_sub(e1, gxx); q11 = wasm_f32x4_pmax(ZERO, v);
    } else {
      // q = 1 - min(dx^2 + dy^2, 1), as minps: the value if below 1, else 1
      // (pmin(1, d) is exactly that).
      v128_t d;
      d = wasm_f32x4_add(fxx, fyy); q00 = wasm_f32x4_sub(ONE, wasm_f32x4_pmin(ONE, d));
      d = wasm_f32x4_add(fxx, gyy); q01 = wasm_f32x4_sub(ONE, wasm_f32x4_pmin(ONE, d));
      d = wasm_f32x4_add(gxx, fyy); q10 = wasm_f32x4_sub(ONE, wasm_f32x4_pmin(ONE, d));
      d = wasm_f32x4_add(gxx, gyy); q11 = wasm_f32x4_sub(ONE, wasm_f32x4_pmin(ONE, d));
    }
    v128_t ix = wasm_i32x4_trunc_sat_f32x4(x0), iy = wasm_i32x4_trunc_sat_f32x4(y0);
    int ix0 = L(ix, 0), iy0 = L(iy, 0);
    int sameX = wasm_i32x4_all_true(wasm_i32x4_eq(ix, wasm_i32x4_splat(ix0)));
    int sameY = wasm_i32x4_all_true(wasm_i32x4_eq(iy, wasm_i32x4_splat(iy0)));
    v128_t s00, s01, s10, s11;
    if (sameX && sameY) {
      // One cell (most groups, at the usual scales): one lookup per corner.
      int c0 = T2[ix0 & 255], c1 = T2[(ix0 + 1) & 255], r0 = T1[iy0 & 255] ^ seed, r1 = T1[(iy0 + 1) & 255] ^ seed;
      s00 = cornerS(fx, fy, q00, c0 ^ r0); s01 = cornerS(fx, gy, q01, c0 ^ r1);
      s10 = cornerS(gx, fy, q10, c1 ^ r0); s11 = cornerS(gx, gy, q11, c1 ^ r1);
    } else {
      v128_t a0 = wasm_v128_and(ix, M), a1 = wasm_v128_and(wasm_i32x4_add(ix, I1), M);
      v128_t c0 = wasm_i32x4_make(T2[L(a0, 0)], T2[L(a0, 1)], T2[L(a0, 2)], T2[L(a0, 3)]);
      v128_t c1 = wasm_i32x4_make(T2[L(a1, 0)], T2[L(a1, 1)], T2[L(a1, 2)], T2[L(a1, 3)]);
      v128_t r0, r1;
      if (sameY) {
        r0 = wasm_i32x4_splat(T1[iy0 & 255] ^ seed); r1 = wasm_i32x4_splat(T1[(iy0 + 1) & 255] ^ seed);
      } else {
        v128_t b0 = wasm_v128_and(iy, M), b1 = wasm_v128_and(wasm_i32x4_add(iy, I1), M);
        r0 = wasm_v128_xor(wasm_i32x4_make(T1[L(b0, 0)], T1[L(b0, 1)], T1[L(b0, 2)], T1[L(b0, 3)]), S);
        r1 = wasm_v128_xor(wasm_i32x4_make(T1[L(b1, 0)], T1[L(b1, 1)], T1[L(b1, 2)], T1[L(b1, 3)]), S);
      }
      s00 = corner(fx, fy, q00, wasm_v128_xor(c0, r0)); s01 = corner(fx, gy, q01, wasm_v128_xor(c0, r1));
      s10 = corner(gx, fy, q10, wasm_v128_xor(c1, r0)); s11 = corner(gx, gy, q11, wasm_v128_xor(c1, r1));
    }
    v128_t sum = grid ? wasm_f32x4_add(wasm_f32x4_add(s11, s10), wasm_f32x4_add(s01, s00))
                      : wasm_f32x4_add(wasm_f32x4_add(s11, s01), wasm_f32x4_add(s10, s00));
    v128_t a = ampp ? wasm_v128_load(&ampp[i]) : AM;
    wasm_v128_store(&out[i], wasm_f32x4_add(wasm_v128_load(&out[i]), wasm_f32x4_mul(sum, a)));
  }
}

// The same over points laid out in rows of w (w a multiple of 4), x the
// same down each column and y the same along each row, amp constant, and on
// a grid one corner (ox, oy) for all. A column's lattice x, and everything
// that depends on it alone, is worked out once, and likewise for a row's y,
// so each point is left with its corners' q, the x half of each gradient
// dot product and the sums. The arithmetic is noise's, and so are the
// results.
static float CFX[CAP], CGX[CAP], CFXX[CAP], CGXX[CAP];
static int CC0[CAP], CC1[CAP], CSAME[CAP / 4];
EXPORT("noise_rows")
void noise_rows(int w, int h, int kind, float s, float offx, float offy, double c, float st,
                const float *xs, const float *ys, float ox, float oy, int seed, float amp, float *out) {
  const v128_t SC = wasm_f32x4_splat(s), OFX = wasm_f32x4_splat(offx), ST = wasm_f32x4_splat(st), OX = wasm_f32x4_splat(ox);
  const v128_t ONE = wasm_f32x4_splat(1.0f), ZERO = wasm_f32x4_splat(0.0f), M = wasm_i32x4_splat(255), I1 = wasm_i32x4_splat(1);
  const v128_t AM = wasm_f32x4_splat(amp);
  const int grid = kind & 1;
  // Columns, from the first row.
  for (int i = 0; i < w; i += 4) {
    v128_t xv = wasm_v128_load(&xs[i]);
    if (kind == 0) xv = wasm_f32x4_mul(wasm_f32x4_add(xv, OFX), SC);
    else if (kind == 1) xv = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_sub(xv, OX), wasm_f32x4_add(OFX, OX)), SC);
    else if (kind == 2) xv = addd(wasm_f32x4_mul(xv, SC), c);
    else xv = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_sub(xv, OX), ST), addd(wasm_f32x4_mul(OX, ST), c)), SC);
    v128_t x0 = wasm_f32x4_floor(xv), fx = wasm_f32x4_sub(xv, x0), gx = wasm_f32x4_sub(fx, ONE);
    wasm_v128_store(&CFX[i], fx); wasm_v128_store(&CGX[i], gx);
    wasm_v128_store(&CFXX[i], wasm_f32x4_mul(fx, fx)); wasm_v128_store(&CGXX[i], wasm_f32x4_mul(gx, gx));
    v128_t ix = wasm_i32x4_trunc_sat_f32x4(x0);
    v128_t a0 = wasm_v128_and(ix, M), a1 = wasm_v128_and(wasm_i32x4_add(ix, I1), M);
    wasm_v128_store(&CC0[i], wasm_i32x4_make(T2[L(a0, 0)], T2[L(a0, 1)], T2[L(a0, 2)], T2[L(a0, 3)]));
    wasm_v128_store(&CC1[i], wasm_i32x4_make(T2[L(a1, 0)], T2[L(a1, 1)], T2[L(a1, 2)], T2[L(a1, 3)]));
    CSAME[i >> 2] = wasm_i32x4_all_true(wasm_i32x4_eq(ix, wasm_i32x4_splat(L(ix, 0))));
  }
  for (int j = 0; j < h; j++) {
    // The row, in single precision as the vector code would have it.
    float y = ys[j * w], yv;
    if (kind == 0) yv = (y + offy) * s;
    else if (kind == 1) yv = ((y - oy) + (offy + oy)) * s;
    else if (kind == 2) yv = y * s;
    else yv = ((y - oy) * st + oy * st) * s;
    float y0 = __builtin_floorf(yv), fy = yv - y0, gy = fy - 1.0f, fyy = fy * fy, gyy = gy * gy;
    int iy = (int)y0, r0 = T1[iy & 255] ^ seed, r1 = T1[(iy + 1) & 255] ^ seed;
    // On a grid, q's row part 1 - dy^2; otherwise dy^2 itself.
    const v128_t E0 = wasm_f32x4_splat(grid ? 1.0f - fyy : fyy), E1 = wasm_f32x4_splat(grid ? 1.0f - gyy : gyy);
    const v128_t FY = wasm_f32x4_splat(fy), GY = wasm_f32x4_splat(gy), R0 = wasm_i32x4_splat(r0), R1 = wasm_i32x4_splat(r1);
    float *o = &out[j * w];
    // The gradient terms of the last one-cell group, for the next if it is
    // in the same cell.
    int lc0 = -1, lc1 = -1;
    v128_t A00 = ZERO, A01 = ZERO, A10 = ZERO, A11 = ZERO, B00 = ZERO, B01 = ZERO, B10 = ZERO, B11 = ZERO;
    for (int i = 0; i < w; i += 4) {
      v128_t fx = wasm_v128_load(&CFX[i]), gx = wasm_v128_load(&CGX[i]);
      v128_t fxx = wasm_v128_load(&CFXX[i]), gxx = wasm_v128_load(&CGXX[i]), v;
      v128_t q00, q01, q10, q11;
      if (grid) {
        v = wasm_f32x4_sub(E0, fxx); q00 = wasm_f32x4_pmax(ZERO, v);
        v = wasm_f32x4_sub(E0, gxx); q10 = wasm_f32x4_pmax(ZERO, v);
        v = wasm_f32x4_sub(E1, fxx); q01 = wasm_f32x4_pmax(ZERO, v);
        v = wasm_f32x4_sub(E1, gxx); q11 = wasm_f32x4_pmax(ZERO, v);
      } else {
        v = wasm_f32x4_add(fxx, E0); q00 = wasm_f32x4_sub(ONE, wasm_f32x4_pmin(ONE, v));
        v = wasm_f32x4_add(fxx, E1); q01 = wasm_f32x4_sub(ONE, wasm_f32x4_pmin(ONE, v));
        v = wasm_f32x4_add(gxx, E0); q10 = wasm_f32x4_sub(ONE, wasm_f32x4_pmin(ONE, v));
        v = wasm_f32x4_add(gxx, E1); q11 = wasm_f32x4_sub(ONE, wasm_f32x4_pmin(ONE, v));
      }
      v128_t s00, s01, s10, s11;
      if (CSAME[i >> 2]) {
        // (dx gx + dy gy) q^3: gx (A) and dy gy (B) one number for the four.
        int c0 = CC0[i], c1 = CC1[i];
        if (c0 != lc0 || c1 != lc1) {
          int k;
          k = c0 ^ r0; A00 = wasm_f32x4_splat(G[2 * k]); B00 = wasm_f32x4_splat(fy * G[2 * k + 1]);
          k = c0 ^ r1; A01 = wasm_f32x4_splat(G[2 * k]); B01 = wasm_f32x4_splat(gy * G[2 * k + 1]);
          k = c1 ^ r0; A10 = wasm_f32x4_splat(G[2 * k]); B10 = wasm_f32x4_splat(fy * G[2 * k + 1]);
          k = c1 ^ r1; A11 = wasm_f32x4_splat(G[2 * k]); B11 = wasm_f32x4_splat(gy * G[2 * k + 1]);
          lc0 = c0; lc1 = c1;
        }
#define CS(dx, q, A, B) wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_mul(dx, A), B), wasm_f32x4_mul(wasm_f32x4_mul(q, q), q))
        s00 = CS(fx, q00, A00, B00); s01 = CS(fx, q01, A01, B01);
        s10 = CS(gx, q10, A10, B10); s11 = CS(gx, q11, A11, B11);
#undef CS
      } else {
        v128_t c0 = wasm_v128_load(&CC0[i]), c1 = wasm_v128_load(&CC1[i]);
        s00 = corner(fx, FY, q00, wasm_v128_xor(c0, R0)); s01 = corner(fx, GY, q01, wasm_v128_xor(c0, R1));
        s10 = corner(gx, FY, q10, wasm_v128_xor(c1, R0)); s11 = corner(gx, GY, q11, wasm_v128_xor(c1, R1));
      }
      v128_t sum = grid ? wasm_f32x4_add(wasm_f32x4_add(s11, s10), wasm_f32x4_add(s01, s00))
                        : wasm_f32x4_add(wasm_f32x4_add(s11, s01), wasm_f32x4_add(s10, s00));
      wasm_v128_store(&o[i], wasm_f32x4_add(wasm_v128_load(&o[i]), wasm_f32x4_mul(sum, AM)));
    }
  }
}

// ------------------------------------------------------------- operators

#define ONEV wasm_f32x4_splat(1.0f)
#define BOOL(m) wasm_v128_and((m), ONEV)
#define TOI(v) wasm_i32x4_trunc_sat_f32x4(v)
#define TOF(v) wasm_f32x4_convert_i32x4(v)

// a - floor(a / b) * b in double precision, two lanes at a time.
static inline v128_t mod2(v128_t a, v128_t b) {
  return wasm_f64x2_sub(a, wasm_f64x2_mul(wasm_f64x2_floor(wasm_f64x2_div(a, b)), b));
}
static inline v128_t modf4(v128_t a, v128_t b) {
  v128_t lo = mod2(wasm_f64x2_promote_low_f32x4(a), wasm_f64x2_promote_low_f32x4(b));
  v128_t hi = mod2(wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(a, a, 1, 1)), wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(b, b, 1, 1)));
  return wasm_i64x2_shuffle(wasm_f32x4_demote_f64x2_zero(lo), wasm_f32x4_demote_f64x2_zero(hi), 0, 2);
}

#define BIN(name, E) \
  EXPORT(#name "_vv") void name##_vv(float *d, const float *pa, const float *pb, int n) { \
    for (int i = 0; i < n; i += 4) { v128_t a = wasm_v128_load(&pa[i]), b = wasm_v128_load(&pb[i]); wasm_v128_store(&d[i], E); } } \
  EXPORT(#name "_vs") void name##_vs(float *d, const float *pa, float s, int n) { \
    v128_t b = wasm_f32x4_splat(s); for (int i = 0; i < n; i += 4) { v128_t a = wasm_v128_load(&pa[i]); wasm_v128_store(&d[i], E); } } \
  EXPORT(#name "_sv") void name##_sv(float *d, float s, const float *pb, int n) { \
    v128_t a = wasm_f32x4_splat(s); for (int i = 0; i < n; i += 4) { v128_t b = wasm_v128_load(&pb[i]); wasm_v128_store(&d[i], E); } }

BIN(add, wasm_f32x4_add(a, b))
BIN(sub, wasm_f32x4_sub(a, b))
BIN(mul, wasm_f32x4_mul(a, b))
BIN(div, wasm_f32x4_div(a, b))
BIN(mod, modf4(a, b))
BIN(min, wasm_f32x4_min(a, b))
BIN(max, wasm_f32x4_max(a, b))
BIN(lt, BOOL(wasm_f32x4_lt(a, b)))
BIN(le, BOOL(wasm_f32x4_le(a, b)))
BIN(gt, BOOL(wasm_f32x4_gt(a, b)))
BIN(ge, BOOL(wasm_f32x4_ge(a, b)))
BIN(eq, BOOL(wasm_f32x4_eq(a, b)))
BIN(ne, BOOL(wasm_f32x4_ne(a, b)))
BIN(band, TOF(wasm_v128_and(TOI(a), TOI(b))))
BIN(bor, TOF(wasm_v128_or(TOI(a), TOI(b))))
BIN(bxor, TOF(wasm_v128_xor(TOI(a), TOI(b))))

#define UN(name, E) \
  EXPORT(#name) void op_##name(float *d, const float *pa, int n) { \
    for (int i = 0; i < n; i += 4) { v128_t a = wasm_v128_load(&pa[i]); wasm_v128_store(&d[i], E); } }

UN(neg, wasm_f32x4_neg(a))
UN(abs, wasm_f32x4_abs(a))
UN(floor, wasm_f32x4_floor(a))
UN(ceil, wasm_f32x4_ceil(a))
UN(sqrt, wasm_f32x4_sqrt(a))
UN(bnot, TOF(wasm_v128_not(TOI(a))))

// clamp(v, lo, hi) = v < lo ? lo : v > hi ? hi : v, with lo and hi constants.
EXPORT("clamp_vss") void clamp_vss(float *d, const float *pv, float lo, float hi, int n) {
  v128_t L = wasm_f32x4_splat(lo), H = wasm_f32x4_splat(hi);
  for (int i = 0; i < n; i += 4) {
    v128_t v = wasm_v128_load(&pv[i]);
    v = wasm_v128_bitselect(H, v, wasm_f32x4_gt(v, H));
    v = wasm_v128_bitselect(L, v, wasm_f32x4_lt(wasm_v128_load(&pv[i]), L));
    wasm_v128_store(&d[i], v);
  }
}
// c != 0 ? a : b over buffers (any of a, b may be a constant: pa/pb null).
EXPORT("ifelse") void ifelse(float *d, const float *pc, const float *pa, float sa, const float *pb, float sb, int n) {
  v128_t A = wasm_f32x4_splat(sa), B = wasm_f32x4_splat(sb), Z = wasm_f32x4_splat(0.0f);
  for (int i = 0; i < n; i += 4) {
    v128_t m = wasm_f32x4_ne(wasm_v128_load(&pc[i]), Z);
    wasm_v128_store(&d[i], wasm_v128_bitselect(pa ? wasm_v128_load(&pa[i]) : A, pb ? wasm_v128_load(&pb[i]) : B, m));
  }
}

// gameFastPow (fastapprox's fastpow, in single precision) for positive a.
static inline v128_t fastpow4(v128_t a, float b) {
  v128_t vi = a;  // the bits
  v128_t mx = wasm_v128_or(wasm_v128_and(vi, wasm_i32x4_splat(0x007FFFFF)), wasm_i32x4_splat(0x3f000000));
  v128_t lg = wasm_f32x4_mul(wasm_f32x4_convert_u32x4(vi), wasm_f32x4_splat(1.1920928955078125e-7f));
  lg = wasm_f32x4_sub(lg, wasm_f32x4_splat(124.22551727294922f));
  lg = wasm_f32x4_sub(lg, wasm_f32x4_mul(wasm_f32x4_splat(1.4980303049087524f), mx));
  lg = wasm_f32x4_sub(lg, wasm_f32x4_div(wasm_f32x4_splat(1.7258800268173218f), wasm_f32x4_add(wasm_f32x4_splat(0.35208871960639954f), mx)));
  v128_t p = wasm_f32x4_mul(lg, wasm_f32x4_splat(b));
  v128_t offset = BOOL(wasm_f32x4_lt(p, wasm_f32x4_splat(0.0f)));
  v128_t m126 = wasm_f32x4_splat(-126.0f);
  v128_t clipp = wasm_v128_bitselect(m126, p, wasm_f32x4_lt(p, m126));
  v128_t z = wasm_f32x4_add(wasm_f32x4_sub(clipp, wasm_f32x4_trunc(clipp)), offset);
  v128_t v = wasm_f32x4_add(wasm_f32x4_add(clipp, wasm_f32x4_splat(121.27405548095703f)),
                            wasm_f32x4_div(wasm_f32x4_splat(27.728023529052734f), wasm_f32x4_sub(wasm_f32x4_splat(4.842525482177734f), z)));
  v = wasm_f32x4_sub(v, wasm_f32x4_mul(wasm_f32x4_splat(1.4901291131973267f), z));
  return wasm_u32x4_trunc_sat_f32x4(wasm_f32x4_mul(v, wasm_f32x4_splat(8388608.0f)));
}
// gamePow(a, b) for a constant b: 0^b by its own rule, whole powers by
// squaring, negative bases to non-whole powers NaN, the rest fastpow.
EXPORT("pow_vs") void pow_vs(float *d, const float *pa, float b, int n) {
  const v128_t Z = wasm_f32x4_splat(0.0f);
  float zero = b == 0 ? 1.0f : b < 0 ? __builtin_inff() : 0.0f;
  const v128_t ZR = wasm_f32x4_splat(zero), NAN4 = wasm_f32x4_splat(__builtin_nanf(""));
  int whole = __builtin_truncf(b) == b && __builtin_fabsf(b) < 2147483648.0f;
  unsigned e = whole ? (unsigned)__builtin_fabsf(b) : 0;
  for (int i = 0; i < n; i += 4) {
    v128_t a = wasm_v128_load(&pa[i]), r;
    if (whole) {
      v128_t x = a; unsigned k = e;
      r = wasm_f32x4_splat(1.0f);
      for (;;) {
        if (k & 1) r = wasm_f32x4_mul(r, x);
        if (k < 2) break;
        x = wasm_f32x4_mul(x, x); k >>= 1;
      }
      if (b < 0) r = wasm_f32x4_div(wasm_f32x4_splat(1.0f), r);
    } else {
      r = fastpow4(a, b);
      r = wasm_v128_bitselect(r, NAN4, wasm_f32x4_ge(a, Z));
    }
    wasm_v128_store(&d[i], wasm_v128_bitselect(ZR, r, wasm_f32x4_eq(a, Z)));
  }
}

// ------------------------------------------------------------ programs

// Runs of the operators above as one call: count instructions of six words,
// [opcode, out, a, b, c, flags], each over n points. Operands are addresses,
// or single-precision constants (as bits) where flags says so: binary
// operator k is opcode 3k (a, b buffers), 3k + 1 (b constant) or 3k + 2 (a
// constant), in the order of BIN below; unary ones follow; then clamp (lo
// and hi constants), ifelse (flags 1: a constant, 2: b constant) and pow (b
// constant).
static inline float bitsf(int w) { float f; __builtin_memcpy(&f, &w, 4); return f; }
#define F(w) bitsf(w)
#define P(w) ((float *)(uintptr_t)(w))
#define OP(k, name) case 3 * k: name##_vv(d, P(c[2]), P(c[3]), n); break; \
                    case 3 * k + 1: name##_vs(d, P(c[2]), F(c[3]), n); break; \
                    case 3 * k + 2: name##_sv(d, F(c[2]), P(c[3]), n); break;
EXPORT("exec") void exec(const int *c, int count, int n) {
  for (; count > 0; count--, c += 6) {
    float *d = P(c[1]);
    switch (c[0]) {
      OP(0, add) OP(1, sub) OP(2, mul) OP(3, div) OP(4, mod) OP(5, min) OP(6, max) OP(7, lt)
      OP(8, le) OP(9, gt) OP(10, ge) OP(11, eq) OP(12, ne) OP(13, band) OP(14, bor) OP(15, bxor)
      case 48: op_neg(d, P(c[2]), n); break;
      case 49: op_abs(d, P(c[2]), n); break;
      case 50: op_floor(d, P(c[2]), n); break;
      case 51: op_ceil(d, P(c[2]), n); break;
      case 52: op_sqrt(d, P(c[2]), n); break;
      case 53: op_bnot(d, P(c[2]), n); break;
      case 54: clamp_vss(d, P(c[2]), F(c[3]), F(c[4]), n); break;
      case 55: ifelse(d, P(c[2]), c[5] & 1 ? 0 : P(c[3]), F(c[3]), c[5] & 2 ? 0 : P(c[4]), F(c[4]), n); break;
      case 56: pow_vs(d, P(c[2]), F(c[3]), n); break;
    }
  }
}

// ------------------------------------------------------------ chunks

// The preview's per-chunk loops (preview.js has the same in JS).

// Each tile's highest probability among count outputs (the first of equals;
// -1 where none is above -infinity) into ids, and its colour into px (RGBA,
// colours 4 bytes each).
EXPORT("chunk_tiles")
void chunk_tiles(int n, int count, const int *outs, int *ids, float *best, const unsigned *colours, unsigned *px) {
  const v128_t NINF = wasm_f32x4_splat(-__builtin_inff());
  for (int k = 0; k < n; k += 4) { wasm_v128_store(&best[k], NINF); wasm_v128_store(&ids[k], wasm_i32x4_splat(-1)); }
  for (int t = 0; t < count; t++) {
    const float *r = (const float *)(uintptr_t)outs[t];
    const v128_t T = wasm_i32x4_splat(t);
    for (int k = 0; k < n; k += 4) {
      v128_t v = wasm_v128_load(&r[k]), b = wasm_v128_load(&best[k]), m = wasm_f32x4_gt(v, b);
      wasm_v128_store(&best[k], wasm_v128_bitselect(v, b, m));
      wasm_v128_store(&ids[k], wasm_v128_bitselect(T, wasm_v128_load(&ids[k]), m));
    }
  }
  for (int k = 0; k < n; k++) px[k] = ids[k] >= 0 ? colours[ids[k]] : 0xff000000u;
}

// Tausworthe taus88, as LuaRandomGenerator.
static unsigned S1, S2, S3;
static inline unsigned taus88(void) {
  unsigned b;
  b = ((S1 << 13) ^ S1) >> 19; S1 = ((S1 & 0xFFFFFFFEu) << 12) ^ b;
  b = ((S2 << 2) ^ S2) >> 25; S2 = ((S2 & 0xFFFFFFF8u) << 4) ^ b;
  b = ((S3 << 3) ^ S3) >> 11; S3 = ((S3 & 0xFFFFFFF0u) << 17) ^ b;
  return S1 ^ S2 ^ S3;
}

// A chunk's entity draws (preview.js's place): for each group, each tile's
// most probable entity among those its tile allows (richness breaking
// ties), then the tiles last to first, each with its entity's draws from
// the chunk's stream. n tiles in rows of w, the first at (x0, y0); ids their
// tiles (-1 for none, which counts as the first). Masks: npat tables of
// ntiles bytes, 1 where a tile blocks entities of that pattern, made into
// per-tile masks in mask (npat * n ints). Groups: for each, its size, then
// six ints per entity: index, probability and richness outputs, pattern,
// draws (placement density), and how it lands (0 tile centre, 1 ore: tile
// centre if its richness is positive, 2 off grid: a random 1/16 tile).
// Draws go into out as (index, x, y) in 1/256 tiles; returns how many.
EXPORT("chunk_draws")
int chunk_draws(int n, int w, int x0, int y0, unsigned seed, const int *ids, int ntiles, int npat,
                const unsigned char *tables, int *mask, int ngroups, const int *groups,
                float *bp, float *br, int *be, int *out) {
  for (int p = 0; p < npat; p++)
    for (int k = 0; k < n; k++) mask[p * n + k] = tables[p * ntiles + (ids[k] < 0 ? 0 : ids[k])] ? -1 : 0;
  S1 = S2 = S3 = seed;
  const v128_t NINF = wasm_f32x4_splat(-__builtin_inff());
  int cnt = 0;
  for (int k = 0; k < n; k += 4) wasm_v128_store(&br[k], wasm_f32x4_splat(0.0f));
  for (int g = 0; g < ngroups; g++) {
    int size = *groups++;
    const int *ent = groups;
    groups += 6 * size;
    for (int k = 0; k < n; k += 4) { wasm_v128_store(&bp[k], NINF); wasm_v128_store(&be[k], wasm_i32x4_splat(-1)); }
    for (int q = 0; q < size; q++) {
      const float *pr = (const float *)(uintptr_t)ent[6 * q + 1], *rr = (const float *)(uintptr_t)ent[6 * q + 2];
      const int *mk = &mask[ent[6 * q + 3] * n];
      const v128_t Q = wasm_i32x4_splat(q);
      for (int k = 0; k < n; k += 4) {
        v128_t v = wasm_v128_load(&pr[k]), r = wasm_v128_load(&rr[k]), b = wasm_v128_load(&bp[k]), c = wasm_v128_load(&br[k]);
        v128_t m = wasm_v128_or(wasm_f32x4_gt(v, b), wasm_v128_and(wasm_f32x4_eq(v, b), wasm_f32x4_gt(r, c)));
        m = wasm_v128_andnot(m, wasm_v128_load(&mk[k]));
        wasm_v128_store(&bp[k], wasm_v128_bitselect(v, b, m));
        wasm_v128_store(&br[k], wasm_v128_bitselect(r, c, m));
        wasm_v128_store(&be[k], wasm_v128_bitselect(Q, wasm_v128_load(&be[k]), m));
      }
    }
    for (int k = n - 1; k >= 0; k--) {
      if (be[k] < 0) continue;
      const int *e = &ent[6 * be[k]];
      int tx = x0 + k % w, ty = y0 + k / w;
      for (int a = 0; a < e[4]; a++) {
        if (!((double)bp[k] > (double)taus88() * 2.3283064365386963e-10)) continue;
        int fx = tx * 256, fy = ty * 256;
        if (e[5] == 1) {
          if (!(br[k] > 0)) continue;
          fx += 128; fy += 128;
        } else if (e[5] == 2) {
          fx = (fx + (int)(taus88() >> 24)) & ~15;
          fy = (fy + (int)(taus88() >> 24)) & ~15;
        } else { fx += 128; fy += 128; }
        out[3 * cnt] = e[0]; out[3 * cnt + 1] = fx; out[3 * cnt + 2] = fy;
        cnt++;
      }
    }
  }
  return cnt;
}

// ------------------------------------------------------------ voronoi

// noise.js's voronoiSearch and its manhattan and chebyshev pyramids, with
// the same arithmetic (single precision for distances, double for the
// pyramid's bisectors), so the same results.

// fastpow (gameFastPow) for one positive number.
static float fastpow1(float a, float b) {
  unsigned vi = __builtin_bit_cast(unsigned, a);
  float mx = __builtin_bit_cast(float, (vi & 0x007FFFFFu) | 0x3f000000u);
  float lg = (float)vi * 1.1920928955078125e-7f - 124.22551727294922f - 1.4980303049087524f * mx
             - 1.7258800268173218f / (0.35208871960639954f + mx);
  float p = lg * b, offset = p < 0 ? 1.0f : 0.0f, clipp = p < -126 ? -126.0f : p;
  float z = (clipp - __builtin_truncf(clipp)) + offset;
  float v = (clipp + 121.27405548095703f) + 27.728023529052734f / (4.842525482177734f - z) - 1.4901291131973267f * z;
  return __builtin_bit_cast(float, (unsigned)__builtin_wasm_trunc_saturate_u_i32_f32(v * 8388608.0f));
}
// A point's distance (VORONOI_DIST): 0 euclidean, 1 manhattan, 2
// chebyshev, 3 minkowski3.
static inline float vdist(int metric, float dx, float dy) {
  float ax = __builtin_fabsf(dx), ay = __builtin_fabsf(dy);
  if (metric == 0) return __builtin_sqrtf(dx * dx + dy * dy);
  if (metric == 1) return ax + ay;
  if (metric == 2) return ax > ay ? ax : ay;
  return fastpow1(ax * ax * ax + ay * ay * ay, 0.3333333432674408f);
}
// Cube root, for bounds only (no libm here).
static double cbrt1(double x) {
  if (!(x > 0) || x == __builtin_inf()) return x;
  unsigned long long bits = __builtin_bit_cast(unsigned long long, x);
  long long e = (long long)((bits >> 52) & 0x7ff) - 1023;
  double y = __builtin_bit_cast(double, (unsigned long long)(e / 3 + 1023) << 52);
  for (int i = 0; i < 8; i++) y -= (y * y * y - x) / (3 * y * y);
  return y;
}
// VORONOI_BOUND.
static inline double vbound(int metric, double x, double y) {
  if (metric == 0) return __builtin_sqrt(x * x + y * y);
  if (metric == 1) return x + y;
  if (metric == 2) return x > y ? x : y;
  return cbrt1(x * x * x + y * y * y);
}
// l1Bisector2.
static double l1bis2(double qx, double qy, double ax, double ay, double bx, double by) {
  double dx = bx - ax, dy = by - ay, px = qx - ax, py = qy - ay, t;
  if (dx < 0) { dx = -dx; px = -px; }
  if (dy < 0) { dy = -dy; py = -py; }
  if (dy > dx) { t = dx; dx = dy; dy = t; t = px; px = py; py = t; }
  double ex = px - (dx + dy) / 2, fx = px - (dx - dy) / 2, fy = py - dy;
  double best = py < 0 ? ex * ex : ex * ex + py * py;
  double d = fy > 0 ? fx * fx : fx * fx + fy * fy;
  if (d < best) best = d;
  if (dy > 0) {
    double s = (py - ex) / (2 * dy);
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    double gx = ex + s * dy, gy = py - s * dy;
    d = gx * gx + gy * gy;
    if (d < best) best = d;
  }
  return best;
}
static inline double bis(int cheb, double x, double y, double ax, double ay, double bx, double by) {
  return cheb ? l1bis2(0.75 * (x + y), 0.75 * (x - y), 0.75 * (ax + ay), 0.75 * (ax - ay), 0.75 * (bx + by), 0.75 * (bx - by))
              : l1bis2(x, y, ax, ay, bx, by);
}

// The search (voronoiSearch's binned path): n points qx/qy in cell units;
// the cells' points gpx/gpy in a grid gw wide from cell (x0, y0); bins a
// quarter cell across, bw of them a row from bin (bx0, by0), nb in all.
// Writes d1, d2 and best (the nearest's index in the grid). For a pyramid
// (pyr 1 manhattan, 2 chebyshev) it then writes its values into out. With
// nb 0, points too spread out to bin, each point searches every cell around
// it (and a pyramid measures every bisector).
// Scratch: bin (n ints), box (4 nb floats), keep (nb side^2 ints), kofs
// (2 nb ints), lists (2 nb (2 + side^2) ints).
EXPORT("voronoi")
void voronoi(int n, const float *qx, const float *qy, int R, int metric, int pyr,
             const float *gpx, const float *gpy, int gw, int x0, int y0, int nb, int bw, int bx0, int by0,
             int *bin, float *box, int *keep, int *kofs, int *lists,
             float *d1, float *d2, int *best, float *out) {
  const float INF = __builtin_inff();
  const int side = 2 * R + 1, ss = side * side;
  if (!nb) {
    for (int i = 0; i < n; i++) {
      float sx = qx[i], sy = qy[i], e1 = INF, e2 = INF;
      int b1 = -1;
      if (sx == sx && sy == sy) {
        int cx = (int)__builtin_floorf(sx), cy = (int)__builtin_floorf(sy);
        for (int sj = cy - R; sj <= cy + R; sj++) {
          int row = (sj - y0) * gw - x0;
          for (int sk = cx - R; sk <= cx + R; sk++) {
            int s = row + sk;
            float sd = vdist(metric, sx - gpx[s], sy - gpy[s]);
            if (sd < e1) { e2 = e1; e1 = sd; b1 = s; } else if (sd < e2) e2 = sd;
          }
        }
      }
      d1[i] = e1; d2[i] = e2; best[i] = b1;
      if (!pyr) continue;
      if (b1 < 0) { out[i] = INF; continue; }
      double x = sx, y = sy, ax = gpx[b1], ay = gpy[b1], bv = INF;
      int cx = (int)__builtin_floorf(sx), cy = (int)__builtin_floorf(sy);
      for (int j = cy - R; j <= cy + R; j++) {
        int row = (j - y0) * gw - x0;
        for (int k = cx - R; k <= cx + R; k++) {
          double bx = gpx[row + k], by = gpy[row + k];
          if (bx == ax && by == ay) continue;
          double v = bis(pyr == 2, x, y, ax, ay, bx, by);
          if (v < bv) bv = v;
        }
      }
      out[i] = (float)__builtin_sqrt(bv);
    }
    return;
  }
  for (int b = 0; b < nb; b++) { box[4 * b] = INF; box[4 * b + 1] = -INF; box[4 * b + 2] = INF; box[4 * b + 3] = -INF; }
  for (int i = 0; i < n; i++) {
    float u = qx[i], v = qy[i];
    if (u != u || v != v) { bin[i] = -1; continue; }
    int b = bin[i] = ((int)__builtin_floorf(u * 4) - bx0) + ((int)__builtin_floorf(v * 4) - by0) * bw;
    float *bx = &box[4 * b];
    if (u < bx[0]) bx[0] = u; if (u > bx[1]) bx[1] = u;
    if (v < bx[2]) bx[2] = v; if (v > bx[3]) bx[3] = v;
  }
  // The cells each bin keeps (see voronoiSearch).
  double tol = metric == 3 ? 0.01 : 1e-5, lo[25];
  int at[25], kp = 0;
  for (int b = 0; b < nb; b++) {
    double l0 = box[4 * b], h0 = box[4 * b + 1], l1 = box[4 * b + 2], h1 = box[4 * b + 3];
    kofs[2 * b] = kofs[2 * b + 1] = kp;
    if (!(l0 <= h0)) continue;
    int cx = (int)__builtin_floor(l0), cy = (int)__builtin_floor(l1), nc = 0;
    double u1 = INF, u2 = INF;
    for (int sj = cy - R; sj <= cy + R; sj++) {
      int row = (sj - y0) * gw - x0;
      for (int sk = cx - R; sk <= cx + R; sk++) {
        int s = row + sk;
        double px = gpx[s], py = gpy[s];
        double dx = px < l0 ? l0 - px : px > h0 ? px - h0 : 0, dy = py < l1 ? l1 - py : py > h1 ? py - h1 : 0;
        double ex = __builtin_fabs(px - l0), fx = __builtin_fabs(px - h0), ey = __builtin_fabs(py - l1), fy = __builtin_fabs(py - h1);
        double hi = vbound(metric, ex > fx ? ex : fx, ey > fy ? ey : fy);
        at[nc] = s; lo[nc++] = vbound(metric, dx, dy);
        if (hi < u1) { u2 = u1; u1 = hi; } else if (hi < u2) u2 = hi;
      }
    }
    double cut = u2 * (1 + tol) + 1e-6;
    for (int c = 0; c < nc; c++) if (lo[c] <= cut) keep[kp++] = at[c];
    kofs[2 * b + 1] = kp;
  }
  for (int i = 0; i < n; i++) {
    float sx = qx[i], sy = qy[i], e1 = INF, e2 = INF;
    int b1 = -1, b = bin[i];
    if (b >= 0) {
      for (int o = kofs[2 * b]; o < kofs[2 * b + 1]; o++) {
        int s = keep[o];
        float sd = vdist(metric, sx - gpx[s], sy - gpy[s]);
        if (sd < e1) { e2 = e1; e1 = sd; b1 = s; } else if (sd < e2) e2 = sd;
      }
    }
    d1[i] = e1; d2[i] = e2; best[i] = b1;
  }
  if (!pyr) return;
  // The pyramid: the distance to the nearest bisector of the nearest point
  // and another, over the bisectors that can be nearest somewhere in the
  // point's bin (see evalVoronoi). Kept for two nearest points a bin.
  const int cheb = pyr == 2, slot = 2 + ss;
  int tmp[25];
  for (int b = 0; b < nb; b++) lists[2 * slot * b] = lists[2 * slot * b + slot] = -1;
  for (int i = 0; i < n; i++) {
    int b = bin[i], a1 = best[i];
    if (b < 0 || a1 < 0) { out[i] = INF; continue; }
    double ax = gpx[a1], ay = gpy[a1];
    int *list = 0, len = 0;
    for (int k = 0; k < 2; k++) {
      int *e = &lists[2 * slot * b + k * slot];
      if (e[0] == a1) { list = e + 2; len = e[1]; break; }
    }
    if (!list) {
      int *e = &lists[2 * slot * b];
      if (e[0] != -1) e += slot;
      if (e[0] != -1) e = 0;
      list = e ? e + 2 : tmp;
      float *bx = &box[4 * b];
      double x = ((double)bx[0] + bx[1]) / 2, y = ((double)bx[2] + bx[3]) / 2;
      double wx = (double)bx[1] - bx[0], wy = (double)bx[3] - bx[2];
      double r = __builtin_sqrt(wx * wx + wy * wy) / 2 * (cheb ? 0.75 * 1.4142135623730951 : 1);
      int cx = (int)__builtin_floorf(bx[0]), cy = (int)__builtin_floorf(bx[2]), nc = 0;
      double lo1 = INF;
      for (int j = cy - R; j <= cy + R; j++) {
        int row = (j - y0) * gw - x0;
        for (int k = cx - R; k <= cx + R; k++) {
          int s = row + k;
          double pbx = gpx[s], pby = gpy[s];
          double v = pbx == ax && pby == ay ? INF : __builtin_sqrt(bis(cheb, x, y, ax, ay, pbx, pby));
          at[nc] = s; lo[nc++] = v;
          if (v < lo1) lo1 = v;
        }
      }
      double lim = lo1 + 2 * r + 1e-7 * (1 + lo1);
      for (int c = 0; c < nc; c++) if (lo[c] <= lim) list[len++] = at[c];
      if (e) { e[0] = a1; e[1] = len; }
    }
    double x = qx[i], y = qy[i], bv = INF;
    for (int c = 0; c < len; c++) {
      double v = bis(cheb, x, y, ax, ay, gpx[list[c]], gpy[list[c]]);
      if (v < bv) bv = v;
    }
    out[i] = (float)__builtin_sqrt(bv);
  }
}

// ------------------------------------------------------------ spots

// spot_noise's cones over points in rows (evalSpot's row path): w columns
// at xs, h rows at ys, out in rows of w (w a multiple of 4). Each of count
// spots (x, y, height, slope) raises a point to height - distance * slope
// where that is higher and the point is within R.
EXPORT("spot_rows")
void spot_rows(int w, int h, const float *xs, const float *ys, int count, const float *spots, float R, float *out) {
  static float DXX[CAP];
  const v128_t RV = wasm_f32x4_splat(R);
  for (int s = 0; s < count; s++) {
    float sx = spots[4 * s], sy = spots[4 * s + 1];
    const v128_t H = wasm_f32x4_splat(spots[4 * s + 2]), SL = wasm_f32x4_splat(spots[4 * s + 3]), SX = wasm_f32x4_splat(sx);
    for (int c = 0; c < w; c += 4) {
      v128_t d = wasm_f32x4_sub(wasm_v128_load(&xs[c]), SX);
      wasm_v128_store(&DXX[c], wasm_f32x4_mul(d, d));
    }
    for (int j = 0; j < h; j++) {
      float ry = ys[j] - sy, dyy = ry * ry;
      // A point's distance is at least its row's own.
      if (__builtin_sqrtf(dyy) > R) continue;
      const v128_t DYY = wasm_f32x4_splat(dyy);
      float *o = &out[j * w];
      for (int c = 0; c < w; c += 4) {
        v128_t d = wasm_f32x4_sqrt(wasm_f32x4_add(wasm_v128_load(&DXX[c]), DYY));
        v128_t v = wasm_f32x4_sub(H, wasm_f32x4_mul(d, SL)), cur = wasm_v128_load(&o[c]);
        v128_t m = wasm_v128_and(wasm_f32x4_ge(RV, d), wasm_f32x4_gt(v, cur));
        wasm_v128_store(&o[c], wasm_v128_bitselect(v, cur, m));
      }
    }
  }
}

// The same for n points anywhere (evalSpot's other path).
EXPORT("spot_points")
void spot_points(int n, const float *xs, const float *ys, int count, const float *spots, float R, float *out) {
  const v128_t RV = wasm_f32x4_splat(R);
  for (int s = 0; s < count; s++) {
    const v128_t SX = wasm_f32x4_splat(spots[4 * s]), SY = wasm_f32x4_splat(spots[4 * s + 1]);
    const v128_t H = wasm_f32x4_splat(spots[4 * s + 2]), SL = wasm_f32x4_splat(spots[4 * s + 3]);
    for (int i = 0; i < n; i += 4) {
      v128_t dx = wasm_f32x4_sub(wasm_v128_load(&xs[i]), SX), dy = wasm_f32x4_sub(wasm_v128_load(&ys[i]), SY);
      v128_t d = wasm_f32x4_sqrt(wasm_f32x4_add(wasm_f32x4_mul(dx, dx), wasm_f32x4_mul(dy, dy)));
      v128_t v = wasm_f32x4_sub(H, wasm_f32x4_mul(d, SL)), cur = wasm_v128_load(&out[i]);
      v128_t m = wasm_v128_and(wasm_f32x4_ge(RV, d), wasm_f32x4_gt(v, cur));
      wasm_v128_store(&out[i], wasm_v128_bitselect(v, cur, m));
    }
  }
}
