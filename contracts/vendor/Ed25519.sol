// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title Ed25519 — RFC 8032 signature verification on the EVM.
/// @notice Written for litnode generation 4 (NodeStake.bond: a node key's
/// proof of possession). A node key is a 32-byte ed25519 public key
/// (protocol/keys.js); an EVM has no ed25519 precompile, so this verifies
/// one in plain EVM arithmetic:
///
///   SHA-512        FIPS 180-4, 64-bit words in uint64 (wrapping, unchecked).
///                  The round constants and initial hash are DERIVED, not
///                  pasted: demo/ed25519-vm.test.mjs recomputes them from the
///                  cube and square roots of the first primes.
///   FIELD          p = 2^255 - 19 with mulmod/addmod; inversion and square
///                  roots by exponentiation through the modexp precompile
///                  (0x05).
///   CURVE          -x^2 + y^2 = 1 + d x^2 y^2, extended coordinates
///                  (X:Y:Z:T), the a = -1 unified addition (complete: d is
///                  not a square) and the dedicated doubling.
///   VERIFY         RFC 8032 §5.1.7, cofactorless, the way OpenSSL and
///                  ref10 verify:
///                    - S < L, else false (no malleable S + L);
///                    - A decodes canonically (y < p, no "negative zero"),
///                      is on the curve, and is NOT of small order (a key in
///                      the 8-torsion signs for nobody: [k]A vanishes and any
///                      R = [S]B "verifies" — fatal for a proof of possession);
///                    - k = SHA-512(R ‖ A ‖ M) mod L;
///                    - R' = [S]B + [k](-A), one joint double-and-add over
///                      253 bits, and its canonical encoding must equal the
///                      32 R bytes. Equality of encodings is decode-R-and-
///                      compare without the second square root: a
///                      non-canonical R, an R off the curve, or an R with the
///                      sign bit set on x = 0 never equals a canonical
///                      encoding, so each is rejected.
///
/// Everything is `internal`: the library is compiled into its caller, no
/// separate deployment, no linking.
library Ed25519 {
    uint256 internal constant P = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed;
    uint256 internal constant L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed;
    uint256 internal constant D = 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3;
    uint256 internal constant D2 = 0x2406d9dc56dffce7198e80f2eef3d13000e0149a8283b156ebd69b9426b2f159;
    uint256 internal constant SQRT_M1 = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0;
    uint256 internal constant BX = 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a;
    uint256 internal constant BY = 0x6666666666666666666666666666666666666666666666666666666666666658;
    /// 2^256 mod L: folds the high half of the 512-bit digest.
    uint256 internal constant R256 = 0x0ffffffffffffffffffffffffffffffec6ef5bf4737dcf70d6ec31748d98951d;

    /// SHA-512 round constants: the first 64 bits of the fractional parts of
    /// the cube roots of the first 80 primes, 8 bytes each, big-endian.
    bytes internal constant K512 = hex"428a2f98d728ae227137449123ef65cdb5c0fbcfec4d3b2fe9b5dba58189dbbc3956c25bf348b53859f111f1b605d019923f82a4af194f9bab1c5ed5da6d8118d807aa98a303024212835b0145706fbe243185be4ee4b28c550c7dc3d5ffb4e272be5d74f27b896f80deb1fe3b1696b19bdc06a725c71235c19bf174cf692694e49b69c19ef14ad2efbe4786384f25e30fc19dc68b8cd5b5240ca1cc77ac9c652de92c6f592b02754a7484aa6ea6e4835cb0a9dcbd41fbd476f988da831153b5983e5152ee66dfaba831c66d2db43210b00327c898fb213fbf597fc7beef0ee4c6e00bf33da88fc2d5a79147930aa72506ca6351e003826f142929670a0e6e7027b70a8546d22ffc2e1b21385c26c9264d2c6dfc5ac42aed53380d139d95b3df650a73548baf63de766a0abb3c77b2a881c2c92e47edaee692722c851482353ba2bfe8a14cf10364a81a664bbc423001c24b8b70d0f89791c76c51a30654be30d192e819d6ef5218d69906245565a910f40e35855771202a106aa07032bbd1b819a4c116b8d2d0c81e376c085141ab532748774cdf8eeb9934b0bcb5e19b48a8391c0cb3c5c95a634ed8aa4ae3418acb5b9cca4f7763e373682e6ff3d6b2b8a3748f82ee5defb2fc78a5636f43172f6084c87814a1f0ab728cc702081a6439ec90befffa23631e28a4506cebde82bde9bef9a3f7b2c67915c67178f2e372532bca273eceea26619cd186b8c721c0c207eada7dd6cde0eb1ef57d4f7fee6ed17806f067aa72176fba0a637dc5a2c898a6113f9804bef90dae1b710b35131c471b28db77f523047d8432caab7b40c724933c9ebe0a15c9bebc431d67c49c100d4c4cc5d4becb3e42b6597f299cfc657e2a5fcb6fab3ad6faec6c44198c4a475817";

    // ------------------------------------------------------------ verify

    /// Verify a 64-byte signature (R ‖ S) by `publicKey` over `message`.
    /// Never reverts on bad input: anything malformed is simply false.
    function verify(bytes32 publicKey, bytes memory signature, bytes memory message) internal view returns (bool) {
        if (signature.length != 64) return false;
        bytes32 r; bytes32 s;
        assembly { r := mload(add(signature, 0x20)) s := mload(add(signature, 0x40)) }
        return verify(publicKey, r, s, message);
    }

    /// Verify with the signature's halves as they appear on the wire:
    /// `r` = signature bytes 0..31, `s` = bytes 32..63.
    function verify(bytes32 publicKey, bytes32 r, bytes32 s, bytes memory message) internal view returns (bool) {
        uint256 sc = reverseBytes(uint256(s));
        if (sc >= L) return false;
        (bool ok, uint256 ax, uint256 ay) = decodePoint(publicKey);
        if (!ok || isSmallOrder(ax, ay)) return false;
        uint256 k = hashToScalar(r, publicKey, message);
        (uint256 x, uint256 y, uint256 z) = _doubleScalarMul(sc, k, ax, ay);
        uint256 zi = _pow(z, P - 2);
        x = mulmod(x, zi, P);
        y = mulmod(y, zi, P);
        return (y | ((x & 1) << 255)) == reverseBytes(uint256(r));
    }

    /// k = SHA-512(R ‖ A ‖ M) as a little-endian integer, mod L.
    function hashToScalar(bytes32 r, bytes32 publicKey, bytes memory message) internal pure returns (uint256) {
        (bytes32 h0, bytes32 h1) = sha512(abi.encodePacked(r, publicKey, message));
        // digest bytes 0..31 are the low 256 bits (little-endian), 32..63 the high
        return addmod(mulmod(reverseBytes(uint256(h1)), R256, L), reverseBytes(uint256(h0)), L);
    }

    // ------------------------------------------------------------ points

    /// RFC 8032 §5.1.3 decoding. Rejects y >= p, x^2 with no root, and the
    /// non-canonical sign bit on x = 0.
    function decodePoint(bytes32 encoded) internal view returns (bool ok, uint256 x, uint256 y) {
        uint256 v = reverseBytes(uint256(encoded));
        uint256 sign = v >> 255;
        y = v & ((1 << 255) - 1);
        if (y >= P) return (false, 0, 0);
        uint256 y2 = mulmod(y, y, P);
        uint256 u = addmod(y2, P - 1, P);            // y^2 - 1
        uint256 w = addmod(mulmod(D, y2, P), 1, P);  // d y^2 + 1 (never 0: -1/d is not a square)
        uint256 w3 = mulmod(mulmod(w, w, P), w, P);
        uint256 w7 = mulmod(mulmod(w3, w3, P), w, P);
        // x = u w^3 (u w^7)^((p-5)/8)
        x = mulmod(mulmod(u, w3, P), _pow(mulmod(u, w7, P), (P - 5) / 8), P);
        uint256 wx2 = mulmod(w, mulmod(x, x, P), P);
        if (wx2 != u) {
            if (addmod(wx2, u, P) != 0) return (false, 0, 0); // u/w is not a square: not on the curve
            x = mulmod(x, SQRT_M1, P);
        }
        if (x == 0 && sign == 1) return (false, 0, 0);
        if ((x & 1) != sign) x = P - x;
        return (true, x, y);
    }

    /// True for the eight points of order dividing 8: [8]A is the identity.
    function isSmallOrder(uint256 x, uint256 y) internal pure returns (bool) {
        uint256 z = 1;
        (x, y, z) = _double(x, y, z);
        (x, y, z) = _double(x, y, z);
        (x, y, z) = _double(x, y, z);
        return x == 0; // the identity is (0 : Z : Z); (0, -1) has order 2 and cannot be an 8-multiple
    }

    function _double(uint256 x, uint256 y, uint256 z) private pure returns (uint256 x3, uint256 y3, uint256 z3) {
        uint256 a = mulmod(x, x, P);
        uint256 b = mulmod(y, y, P);
        uint256 c = mulmod(z, z, P); c = addmod(c, c, P);
        uint256 s = addmod(x, y, P);
        uint256 h = addmod(a, b, P);
        uint256 e = addmod(mulmod(s, s, P), P - h, P); // (X+Y)^2 - A - B
        uint256 g = addmod(b, P - a, P);                // B - A
        uint256 f = addmod(g, P - c, P);                // G - C
        h = P - h;                                      // -(A + B)
        return (mulmod(e, f, P), mulmod(g, h, P), mulmod(f, g, P));
    }

    /// [s]B + [k](-A) in extended coordinates; returns projective (X, Y, Z).
    /// Points are cached as (Y - X, Y + X, 2d T, 2 Z) for the addition.
    function _doubleScalarMul(uint256 s, uint256 k, uint256 ax, uint256 ay) private pure returns (uint256 x, uint256 y, uint256 z) {
        uint256[12] memory tbl;
        // B
        tbl[0] = addmod(BY, P - BX, P);
        tbl[1] = addmod(BY, BX, P);
        tbl[2] = mulmod(mulmod(BX, BY, P), D2, P);
        tbl[3] = 2;
        // -A = (-ax, ay)
        tbl[4] = addmod(ay, ax, P);
        tbl[5] = addmod(ay, P - ax, P);
        tbl[6] = addmod(0, P - mulmod(mulmod(ax, ay, P), D2, P), P);
        tbl[7] = 2;
        assembly {
            // unified addition, a = -1: (x, y, z, t) + cached(ptr)
            function padd(x1, y1, z1, t1, ptr) -> x3, y3, z3, t3 {
                let p := 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed
                let a := mulmod(addmod(y1, sub(p, x1), p), mload(ptr), p)   // (Y1-X1)(Y2-X2)
                let b := mulmod(addmod(y1, x1, p), mload(add(ptr, 0x20)), p) // (Y1+X1)(Y2+X2)
                t1 := mulmod(t1, mload(add(ptr, 0x40)), p)                   // C = T1 2d T2
                z1 := mulmod(z1, mload(add(ptr, 0x60)), p)                   // D = Z1 2 Z2
                x1 := addmod(b, sub(p, a), p)                                // E = B - A
                y1 := addmod(b, a, p)                                        // H = B + A
                b := addmod(z1, sub(p, t1), p)                               // F = D - C
                a := addmod(z1, t1, p)                                       // G = D + C
                x3 := mulmod(x1, b, p)
                y3 := mulmod(a, y1, p)
                t3 := mulmod(x1, y1, p)
                z3 := mulmod(b, a, p)
            }
            // doubling, a = -1
            function pdbl(x1, y1, z1) -> x3, y3, z3, t3 {
                let p := 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed
                let a := mulmod(x1, x1, p)
                let b := mulmod(y1, y1, p)
                z1 := mulmod(z1, z1, p) z1 := addmod(z1, z1, p)              // C = 2 Z^2
                x1 := addmod(x1, y1, p) x1 := mulmod(x1, x1, p)              // (X+Y)^2
                y1 := addmod(a, b, p)                                        // A + B
                x1 := addmod(x1, sub(p, y1), p)                              // E
                b := addmod(b, sub(p, a), p)                                 // G = B - A
                z1 := addmod(b, sub(p, z1), p)                               // F = G - C
                y1 := sub(p, y1)                                             // H = -(A + B)
                x3 := mulmod(x1, z1, p)
                y3 := mulmod(b, y1, p)
                t3 := mulmod(x1, y1, p)
                z3 := mulmod(z1, b, p)
            }
            let p := 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed
            // tbl[8..11] = cached(B - A)
            {
                let bx := 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a
                let by := 0x6666666666666666666666666666666666666666666666666666666666666658
                let x1, y1, z1, t1 := padd(bx, by, 1, mulmod(bx, by, p), add(tbl, 0x80))
                mstore(add(tbl, 0x100), addmod(y1, sub(p, x1), p))
                mstore(add(tbl, 0x120), addmod(y1, x1, p))
                mstore(add(tbl, 0x140), mulmod(t1, 0x2406d9dc56dffce7198e80f2eef3d13000e0149a8283b156ebd69b9426b2f159, p))
                mstore(add(tbl, 0x160), addmod(z1, z1, p))
            }
            let t := 0
            x := 0
            y := 1
            z := 1
            // s, k < L < 2^253: bits 252..0, most significant first
            for { let i := 253 } i { } {
                i := sub(i, 1)
                x, y, z, t := pdbl(x, y, z)
                let sel := or(and(shr(i, s), 1), shl(1, and(shr(i, k), 1)))
                if sel { x, y, z, t := padd(x, y, z, t, add(tbl, shl(7, sub(sel, 1)))) }
            }
        }
    }

    // ------------------------------------------------------------ helpers

    /// base^e mod p through the modexp precompile.
    function _pow(uint256 base, uint256 e) private view returns (uint256 r) {
        assembly {
            let m := mload(0x40)
            mstore(m, 0x20)
            mstore(add(m, 0x20), 0x20)
            mstore(add(m, 0x40), 0x20)
            mstore(add(m, 0x60), base)
            mstore(add(m, 0x80), e)
            mstore(add(m, 0xa0), 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed)
            if iszero(staticcall(gas(), 0x05, m, 0xc0, m, 0x20)) { revert(0, 0) }
            r := mload(m)
        }
    }

    /// Byte order reversal of a 256-bit word (ed25519 encodes little-endian).
    function reverseBytes(uint256 v) internal pure returns (uint256) {
        v = ((v >> 8) & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff)
          | ((v & 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff) << 8);
        v = ((v >> 16) & 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff)
          | ((v & 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff) << 16);
        v = ((v >> 32) & 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff)
          | ((v & 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff) << 32);
        v = ((v >> 64) & 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff)
          | ((v & 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff) << 64);
        return (v >> 128) | (v << 128);
    }

    // ------------------------------------------------------------ SHA-512

    /// FIPS 180-4 SHA-512. Returns the 64-byte digest as two words, bytes
    /// 0..31 then 32..63.
    function sha512(bytes memory data) internal pure returns (bytes32, bytes32) {
        unchecked {
            uint256 len = data.length;
            uint256 padded = ((len + 17 + 127) / 128) * 128;
            // data ‖ 0x80 ‖ zeros ‖ 128-bit big-endian bit length (the high 64 bits are zero here)
            bytes memory buf = abi.encodePacked(data, bytes1(0x80), new bytes(padded - len - 9), uint64(len * 8));
            uint64[8] memory hs = [
                uint64(0x6a09e667f3bcc908), 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
                0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179
            ];
            uint64[80] memory w;
            bytes memory kk = K512;
            for (uint256 off = 0; off < padded; off += 128) {
                for (uint256 t = 0; t < 16; t++) {
                    uint64 word;
                    assembly { word := shr(192, mload(add(add(buf, 0x20), add(off, shl(3, t))))) }
                    w[t] = word;
                }
                for (uint256 t = 16; t < 80; t++) {
                    uint64 a = w[t - 15];
                    uint64 b = w[t - 2];
                    w[t] = w[t - 16] + ((a >> 1 | a << 63) ^ (a >> 8 | a << 56) ^ (a >> 7))
                         + w[t - 7] + ((b >> 19 | b << 45) ^ (b >> 61 | b << 3) ^ (b >> 6));
                }
                _compress(hs, w, kk);
            }
            return (
                bytes32(uint256(hs[0]) << 192 | uint256(hs[1]) << 128 | uint256(hs[2]) << 64 | uint256(hs[3])),
                bytes32(uint256(hs[4]) << 192 | uint256(hs[5]) << 128 | uint256(hs[6]) << 64 | uint256(hs[7]))
            );
        }
    }

    /// The 80 rounds over one scheduled block. Words are uint64 values held
    /// in full 256-bit slots (a memory uint64[] element is one word); every
    /// sum is masked back to 64 bits before it is rotated or stored.
    function _compress(uint64[8] memory hs, uint64[80] memory w, bytes memory kk) private pure {
        assembly {
            function rotr(x, n) -> r { r := and(or(shr(n, x), shl(sub(64, n), x)), 0xffffffffffffffff) }
            let a := mload(hs)
            let b := mload(add(hs, 0x20))
            let c := mload(add(hs, 0x40))
            let d := mload(add(hs, 0x60))
            let e := mload(add(hs, 0x80))
            let f := mload(add(hs, 0xa0))
            let g := mload(add(hs, 0xc0))
            let h := mload(add(hs, 0xe0))
            for { let t := 0 } lt(t, 80) { t := add(t, 1) } {
                // T1 = h + Σ1(e) + Ch(e, f, g) + K[t] + W[t]
                let t1 := add(add(h, xor(xor(rotr(e, 14), rotr(e, 18)), rotr(e, 41))), xor(and(e, f), and(not(e), g)))
                t1 := add(add(t1, shr(192, mload(add(add(kk, 0x20), shl(3, t))))), mload(add(w, shl(5, t))))
                h := g
                g := f
                f := e
                e := and(add(d, t1), 0xffffffffffffffff)
                d := c
                c := b
                b := a
                // T2 = Σ0(a) + Maj(a, b, c), with the old a, b, c now in b, c, d
                a := and(add(t1, add(xor(xor(rotr(b, 28), rotr(b, 34)), rotr(b, 39)), xor(xor(and(b, c), and(b, d)), and(c, d)))), 0xffffffffffffffff)
            }
            mstore(hs, and(add(mload(hs), a), 0xffffffffffffffff))
            mstore(add(hs, 0x20), and(add(mload(add(hs, 0x20)), b), 0xffffffffffffffff))
            mstore(add(hs, 0x40), and(add(mload(add(hs, 0x40)), c), 0xffffffffffffffff))
            mstore(add(hs, 0x60), and(add(mload(add(hs, 0x60)), d), 0xffffffffffffffff))
            mstore(add(hs, 0x80), and(add(mload(add(hs, 0x80)), e), 0xffffffffffffffff))
            mstore(add(hs, 0xa0), and(add(mload(add(hs, 0xa0)), f), 0xffffffffffffffff))
            mstore(add(hs, 0xc0), and(add(mload(add(hs, 0xc0)), g), 0xffffffffffffffff))
            mstore(add(hs, 0xe0), and(add(mload(add(hs, 0xe0)), h), 0xffffffffffffffff))
        }
    }
}
