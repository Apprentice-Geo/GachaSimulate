//! Xoshiro256++ with a separate, reproducible stream for each (seed, run index).
//! Neither batch size nor scheduling enters the seed derivation.

use gachasimulate_types::PoolEntry;

const SEED_DOMAIN: u64 = 0x6761_6368_6173_696d; // "gachasim"
const RUN_DOMAIN: u64 = 0x9e37_79b9_7f4a_7c15;

pub(crate) struct RunRng([u64; 4]);

impl RunRng {
    /// Avalanche both inputs with the SplitMix64 finalizer before combining
    /// them modulo 2^64. With a and b the mixed inputs, the first two words
    /// encode (a + b, a + 2b) invertibly, so distinct pairs start in distinct
    /// states. Mixing these sums and their rotated combinations also diffuses
    /// neighboring inputs across the state. When both sums are zero, the
    /// third word is mix(RUN_DOMAIN), which rules out the all-zero state.
    pub(crate) fn new(seed: i64, run_index: u64) -> Self {
        let a = mix(seed as u64 ^ SEED_DOMAIN);
        let b = mix(run_index ^ RUN_DOMAIN);
        let low = a.wrapping_add(b);
        let high = a.wrapping_add(b.wrapping_mul(2));
        Self([
            mix(low),
            mix(high),
            mix(low ^ high.rotate_left(32) ^ RUN_DOMAIN),
            mix(high ^ low.rotate_left(32) ^ SEED_DOMAIN),
        ])
    }

    fn next_u64(&mut self) -> u64 {
        let [a, b, c, d] = &mut self.0;
        let result = a.wrapping_add(*d).rotate_left(23).wrapping_add(*a);
        let t = *b << 17;
        *c ^= *a;
        *d ^= *b;
        *b ^= *c;
        *a ^= *d;
        *c ^= t;
        *d = d.rotate_left(45);
        result
    }

    pub(crate) fn entry_index(&mut self, entries: &[PoolEntry]) -> usize {
        threshold_index(entries, unit_f64(|| self.next_u64()))
    }
}

fn mix(mut word: u64) -> u64 {
    word = (word ^ (word >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    word = (word ^ (word >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    word ^ (word >> 31)
}

/// Read the words as a binary fraction, most significant bit first, and round
/// down to the nearest `f64`. With independent uniform bits, each output gets
/// the probability mass of its bin [output, next float), so the probability of
/// any interval [a, b) with `f64` endpoints is exactly b - a.
///
/// After `zeros` leading zeros, the first 1 has exponent -1 - zeros. Normal
/// values keep that implicit 1 and the next 52 fraction bits. Subnormals keep
/// only bits through position -1074, the smallest positive float's exponent.
/// A prefix of 1074 zeros rounds to zero. The remaining bits of the last word
/// are discarded. One word suffices whenever the first 1 is among its first
/// 12 bits, which happens on 1 - 2^-12 (about 99.976%) of draws.
fn unit_f64(mut next_word: impl FnMut() -> u64) -> f64 {
    const FRACTION_BITS: u32 = f64::MANTISSA_DIGITS - 1;
    const FRACTION_MASK: u64 = (1 << FRACTION_BITS) - 1;
    const SUBNORMAL_PREFIX: u32 = 1022;
    const ZERO_PREFIX: u32 = SUBNORMAL_PREFIX + FRACTION_BITS;

    let mut skipped_zeros = 0;
    loop {
        let word = next_word();
        let leading_zeros = word.leading_zeros();
        let zeros = skipped_zeros + leading_zeros;
        if zeros >= ZERO_PREFIX {
            return 0.0;
        }
        if word == 0 {
            skipped_zeros = zeros;
            continue;
        }

        let exponent = SUBNORMAL_PREFIX.saturating_sub(zeros);
        let kept_bits = (ZERO_PREFIX - zeros).min(FRACTION_BITS + 1);
        let available_bits = u64::BITS - leading_zeros;
        let significand = if available_bits >= kept_bits {
            word >> (available_bits - kept_bits)
        } else {
            let missing_bits = kept_bits - available_bits;
            (word << missing_bits) | (next_word() >> (u64::BITS - missing_bits))
        };
        // The mask drops the implicit leading 1 of normals and keeps the
        // entire significand of subnormals, which have no implicit bit.
        return f64::from_bits(
            (u64::from(exponent) << FRACTION_BITS) | (significand & FRACTION_MASK),
        );
    }
}

/// Select the first threshold strictly greater than u. Entries own
/// half-open intervals [previous threshold, threshold), with 0 as the first
/// lower bound. `unit_f64` assigns each interval its full probability mass,
/// including at thresholds that differ by a single representable value.
fn threshold_index(entries: &[PoolEntry], u: f64) -> usize {
    entries.partition_point(|entry| entry.threshold <= u)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gachasimulate_types::ActionRange;

    fn sample(words: &[u64]) -> f64 {
        let mut words = words.iter().copied();
        let value = unit_f64(|| words.next().expect("unexpected extra word requested"));
        assert_eq!(words.next(), None, "unused sample word");
        value
    }

    #[test]
    fn frozen_xoshiro_streams() {
        for (seed, run, expected) in [
            (
                0,
                0,
                [
                    0xe9ea_5c30_1ef2_5529,
                    0xdce4_7f5a_c725_2926,
                    0x306c_f31c_0839_db4d,
                    0x3c18_adcf_622a_4ed5,
                ],
            ),
            (
                0,
                1,
                [
                    0xb2d4_4303_9024_a003,
                    0x22c1_d777_9ec1_fd73,
                    0xa7ea_99bf_a975_2cdb,
                    0x09f1_e834_e1ed_ffbc,
                ],
            ),
            (
                -5,
                17,
                [
                    0x043a_8659_f515_fc54,
                    0x0819_ec6c_4e42_94f0,
                    0xe0bd_db83_b43e_d31a,
                    0x5f8a_0e06_1bb7_4ffc,
                ],
            ),
            (
                i64::MIN,
                u64::MAX,
                [
                    0xcf25_1e33_4f92_6a28,
                    0xe923_fba6_e3ed_7a62,
                    0xae9d_18d1_34c9_d281,
                    0x64f3_4acf_6181_9576,
                ],
            ),
        ] {
            let mut rng = RunRng::new(seed, run);
            assert_eq!(expected, expected.map(|_| rng.next_u64()));
        }
    }

    #[test]
    fn frozen_uniform_conversion() {
        for (words, bits) in [
            (&[0x8000_0000_0000_07ff][..], 0x3fe0_0000_0000_0000),
            (&[0x4000_0000_0000_0400], 0x3fd0_0000_0000_0001),
            (&[0xe9ea_5c30_1ef2_5529], 0x3fed_3d4b_8603_de4a),
            (&[0x043a_8659_f515_fc54], 0x3f90_ea19_67d4_57f1),
            (&[u64::MAX], 0x3fef_ffff_ffff_ffff),
            (&[0x001f_ffff_ffff_ffff], 0x3f3f_ffff_ffff_ffff),
            (&[0x000f_ffff_ffff_ffff, 1 << 63], 0x3f2f_ffff_ffff_ffff),
            (
                &[0x000f_ffff_ffff_ffff, (1 << 63) - 1],
                0x3f2f_ffff_ffff_fffe,
            ),
            (&[0, u64::MAX], 0x3bef_ffff_ffff_ffff),
        ] {
            assert_eq!(sample(words).to_bits(), bits);
        }
    }

    #[test]
    fn floors_at_the_subnormal_and_zero_boundaries() {
        let mut words = [0; 17];
        for (penultimate, last, bits) in [
            (4, 0, f64::MIN_POSITIVE.to_bits()),
            (3, u64::MAX, f64::MIN_POSITIVE.to_bits() - 1),
            (0, 1 << 14, 1),
            (0, (1 << 14) - 1, 0),
            (0, 0, 0),
        ] {
            words[15] = penultimate;
            words[16] = last;
            assert_eq!(sample(&words).to_bits(), bits);
        }
    }

    #[test]
    fn draw_on_threshold_moves_to_the_next_entry() {
        let entries = [0.25, 0.75, 1.0].map(|threshold| PoolEntry {
            threshold,
            actions: ActionRange::EMPTY,
        });
        for (word, index) in [
            (1 << 61, 0),
            ((1 << 62) - 1, 0),
            (1 << 62, 1),
            ((3 << 62) - 1, 1),
            (3 << 62, 2),
            (u64::MAX, 2),
        ] {
            assert_eq!(threshold_index(&entries, sample(&[word])), index);
        }
    }

    #[test]
    fn tiny_positive_intervals_are_reachable() {
        let entries = [2.0_f64.powi(-54), 2.0_f64.powi(-53), 1.0].map(|threshold| PoolEntry {
            threshold,
            actions: ActionRange::EMPTY,
        });
        for (word, index) in [(1 << 9, 0), (1 << 10, 1), ((1 << 11) - 1, 1), (1 << 11, 2)] {
            assert_eq!(threshold_index(&entries, sample(&[word, 0])), index);
        }
    }
}
