// WebAssembly (with SIMD) kernels for web/static/mapgen/noise.js, four
// points at a time. Each gives the same bits as the JS it replaces:
//
// - noise: the corner sums of the game's Noise::noise (noiseKernel in
//   noise.js) and the octave coordinates feeding it (noiseSum);
// - element-wise operators over the program's buffers, which noise.js keeps
//   in this module's memory (add_vv(dst, a, b, n), add_vs(dst, a, s, n),
//   add_sv(dst, s, b, n), ...). JS computes these in double precision and
//   rounds to single; for + - * / and sqrt that is the same as computing in
//   single precision, so these work in single precision, except mod, which
//   works in double as the JS does;
// - pow with a constant exponent, as gamePow;
// - exec: runs of those operators in one call, as a program's plan has them.
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
