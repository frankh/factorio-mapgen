// The corner sums of the game's Noise::noise (see noiseKernel in
// web/static/mapgen/noise.js, which this matches bit for bit), four points
// at a time with WebAssembly SIMD:
//   OUT[i] += amp * sum over the four lattice corners of (g . d) q^3
// for points already in lattice units in X/Y. grid selects the chunk-grid
// version of q and of the summation order. amp is a constant, or AMP[i]
// when useAmp is set. The caller pads n to a multiple of 4.
#include <wasm_simd128.h>

#define CAP 4096
#define EXPORT(name) __attribute__((export_name(name)))

static float X[CAP], Y[CAP], OUT[CAP], AMP[CAP];
static float XS[CAP], YS[CAP], OX[CAP], OY[CAP];  // positions, and their chunk's corner on a grid
static float G[512];  // gradient (x, y) pairs, already shuffled for the seed
static unsigned char T1[256], T2[256];  // row (y) and column (x) hashes

EXPORT("xs") float *xs_(void) { return XS; }
EXPORT("ys") float *ys_(void) { return YS; }
EXPORT("ox") float *ox_(void) { return OX; }
EXPORT("oy") float *oy_(void) { return OY; }
EXPORT("x") float *x_(void) { return X; }
EXPORT("y") float *y_(void) { return Y; }
EXPORT("out") float *out_(void) { return OUT; }
EXPORT("amp") float *amp_(void) { return AMP; }
EXPORT("g") float *g_(void) { return G; }
EXPORT("t1") unsigned char *t1_(void) { return T1; }
EXPORT("t2") unsigned char *t2_(void) { return T2; }
EXPORT("cap") int cap_(void) { return CAP; }

#define L(v, j) wasm_i32x4_extract_lane(v, j)

// The gradients of four corners: x components in *gx, y components in *gy.
static inline void grads(int k0, int k1, int k2, int k3, v128_t *gx, v128_t *gy) {
  v128_t a = wasm_v128_load64_zero(&G[2 * k0]), b = wasm_v128_load64_zero(&G[2 * k1]);
  v128_t c = wasm_v128_load64_zero(&G[2 * k2]), d = wasm_v128_load64_zero(&G[2 * k3]);
  v128_t ab = wasm_i64x2_shuffle(a, b, 0, 2), cd = wasm_i64x2_shuffle(c, d, 0, 2);
  *gx = wasm_i32x4_shuffle(ab, cd, 0, 2, 4, 6);
  *gy = wasm_i32x4_shuffle(ab, cd, 1, 3, 5, 7);
}

static inline v128_t corner(v128_t dx, v128_t dy, v128_t q, int k0, int k1, int k2, int k3) {
  v128_t gx, gy;
  grads(k0, k1, k2, k3, &gx, &gy);
  v128_t dot = wasm_f32x4_add(wasm_f32x4_mul(dx, gx), wasm_f32x4_mul(dy, gy));
  return wasm_f32x4_mul(dot, wasm_f32x4_mul(wasm_f32x4_mul(q, q), q));
}

EXPORT("kernel")
void kernel(int n, int grid, int s, float amp, int useAmp) {
  const v128_t ONE = wasm_f32x4_splat(1.0f), ZERO = wasm_f32x4_splat(0.0f), M = wasm_i32x4_splat(255), I1 = wasm_i32x4_splat(1);
  const v128_t S = wasm_i32x4_splat(s), AM = wasm_f32x4_splat(amp);
  for (int i = 0; i < n; i += 4) {
    v128_t xv = wasm_v128_load(&X[i]), yv = wasm_v128_load(&Y[i]);
    v128_t x0 = wasm_f32x4_floor(xv), y0 = wasm_f32x4_floor(yv);
    v128_t fx = wasm_f32x4_sub(xv, x0), fy = wasm_f32x4_sub(yv, y0);
    v128_t gx = wasm_f32x4_sub(fx, ONE), gy = wasm_f32x4_sub(fy, ONE);
    v128_t ix = wasm_i32x4_trunc_sat_f32x4(x0), iy = wasm_i32x4_trunc_sat_f32x4(y0);
    v128_t a0 = wasm_v128_and(ix, M), a1 = wasm_v128_and(wasm_i32x4_add(ix, I1), M);
    v128_t b0 = wasm_v128_and(iy, M), b1 = wasm_v128_and(wasm_i32x4_add(iy, I1), M);
    v128_t c0 = wasm_i32x4_make(T2[L(a0, 0)], T2[L(a0, 1)], T2[L(a0, 2)], T2[L(a0, 3)]);
    v128_t c1 = wasm_i32x4_make(T2[L(a1, 0)], T2[L(a1, 1)], T2[L(a1, 2)], T2[L(a1, 3)]);
    v128_t r0 = wasm_v128_xor(wasm_i32x4_make(T1[L(b0, 0)], T1[L(b0, 1)], T1[L(b0, 2)], T1[L(b0, 3)]), S);
    v128_t r1 = wasm_v128_xor(wasm_i32x4_make(T1[L(b1, 0)], T1[L(b1, 1)], T1[L(b1, 2)], T1[L(b1, 3)]), S);
    v128_t k00 = wasm_v128_xor(c0, r0), k01 = wasm_v128_xor(c0, r1), k10 = wasm_v128_xor(c1, r0), k11 = wasm_v128_xor(c1, r1);
    v128_t fxx = wasm_f32x4_mul(fx, fx), gxx = wasm_f32x4_mul(gx, gx), fyy = wasm_f32x4_mul(fy, fy), gyy = wasm_f32x4_mul(gy, gy);
    v128_t q00, q01, q10, q11;
    if (grid) {
      // q = max((1 - dy^2) - dx^2, 0), as maxps: the value if above 0, else 0.
      v128_t e0 = wasm_f32x4_sub(ONE, fyy), e1 = wasm_f32x4_sub(ONE, gyy), v;
      v = wasm_f32x4_sub(e0, fxx); q00 = wasm_v128_and(v, wasm_f32x4_gt(v, ZERO));
      v = wasm_f32x4_sub(e0, gxx); q10 = wasm_v128_and(v, wasm_f32x4_gt(v, ZERO));
      v = wasm_f32x4_sub(e1, fxx); q01 = wasm_v128_and(v, wasm_f32x4_gt(v, ZERO));
      v = wasm_f32x4_sub(e1, gxx); q11 = wasm_v128_and(v, wasm_f32x4_gt(v, ZERO));
    } else {
      // q = 1 - min(dx^2 + dy^2, 1), as minps: the value if below 1, else 1.
      v128_t d;
      d = wasm_f32x4_add(fxx, fyy); q00 = wasm_f32x4_sub(ONE, wasm_v128_bitselect(d, ONE, wasm_f32x4_lt(d, ONE)));
      d = wasm_f32x4_add(fxx, gyy); q01 = wasm_f32x4_sub(ONE, wasm_v128_bitselect(d, ONE, wasm_f32x4_lt(d, ONE)));
      d = wasm_f32x4_add(gxx, fyy); q10 = wasm_f32x4_sub(ONE, wasm_v128_bitselect(d, ONE, wasm_f32x4_lt(d, ONE)));
      d = wasm_f32x4_add(gxx, gyy); q11 = wasm_f32x4_sub(ONE, wasm_v128_bitselect(d, ONE, wasm_f32x4_lt(d, ONE)));
    }
    v128_t s00 = corner(fx, fy, q00, L(k00, 0), L(k00, 1), L(k00, 2), L(k00, 3));
    v128_t s01 = corner(fx, gy, q01, L(k01, 0), L(k01, 1), L(k01, 2), L(k01, 3));
    v128_t s10 = corner(gx, fy, q10, L(k10, 0), L(k10, 1), L(k10, 2), L(k10, 3));
    v128_t s11 = corner(gx, gy, q11, L(k11, 0), L(k11, 1), L(k11, 2), L(k11, 3));
    v128_t sum = grid ? wasm_f32x4_add(wasm_f32x4_add(s11, s10), wasm_f32x4_add(s01, s00))
                      : wasm_f32x4_add(wasm_f32x4_add(s11, s01), wasm_f32x4_add(s10, s00));
    v128_t a = useAmp ? wasm_v128_load(&AMP[i]) : AM;
    wasm_v128_store(&OUT[i], wasm_f32x4_add(wasm_v128_load(&OUT[i]), wasm_f32x4_mul(sum, a)));
  }
}

// One octave's lattice coordinates, into X/Y from XS/YS, as noise.js's
// noiseSum works them out (kind 0 point, 1 grid, 2 multioctave point,
// 3 multioctave grid). The double-precision steps are the game's.
static inline v128_t addd(v128_t f, double c) {
  v128_t C = wasm_f64x2_splat(c);
  v128_t lo = wasm_f64x2_add(wasm_f64x2_promote_low_f32x4(f), C);
  v128_t hi = wasm_f64x2_add(wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(f, f, 1, 1)), C);
  return wasm_i64x2_shuffle(wasm_f32x4_demote_f64x2_zero(lo), wasm_f32x4_demote_f64x2_zero(hi), 0, 2);
}
EXPORT("coords")
void coords(int n, int kind, float s, float offx, float offy, double c, float st) {
  const v128_t SC = wasm_f32x4_splat(s), OFX = wasm_f32x4_splat(offx), OFY = wasm_f32x4_splat(offy), ST = wasm_f32x4_splat(st);
  for (int i = 0; i < n; i += 4) {
    v128_t x = wasm_v128_load(&XS[i]), y = wasm_v128_load(&YS[i]);
    if (kind == 0) {
      x = wasm_f32x4_mul(wasm_f32x4_add(x, OFX), SC);
      y = wasm_f32x4_mul(wasm_f32x4_add(y, OFY), SC);
    } else if (kind == 1) {
      v128_t ox = wasm_v128_load(&OX[i]), oy = wasm_v128_load(&OY[i]);
      x = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_sub(x, ox), wasm_f32x4_add(OFX, ox)), SC);
      y = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_sub(y, oy), wasm_f32x4_add(OFY, oy)), SC);
    } else if (kind == 2) {
      x = addd(wasm_f32x4_mul(x, SC), c);
      y = wasm_f32x4_mul(y, SC);
    } else {
      v128_t ox = wasm_v128_load(&OX[i]), oy = wasm_v128_load(&OY[i]);
      v128_t oxk = addd(wasm_f32x4_mul(ox, ST), c), oyk = wasm_f32x4_mul(oy, ST);
      x = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_sub(x, ox), ST), oxk), SC);
      y = wasm_f32x4_mul(wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_sub(y, oy), ST), oyk), SC);
    }
    wasm_v128_store(&X[i], x);
    wasm_v128_store(&Y[i], y);
  }
}
