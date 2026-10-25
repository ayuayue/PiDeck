#!/usr/bin/env python3
"""beatmap.py - measure a track's tempo and beat grid with ffmpeg + pure Python.

numpy is not installed on this machine, so instead of an STFT we decode two
band-limited envelopes straight from ffmpeg (low band for kicks, mid band for
transients) and run the autocorrelation on those. Output is the beat map the
film cues are derived from - never a guessed BPM.

Usage: python beatmap.py <track.mp3> [--start SEC] [--bars N] [--bpm-hint 120]
"""
import subprocess
import sys

FRAME = 0.01  # 10 ms analysis frame


def band_envelope(path, rate, hp, lp):
    """RMS envelope of a band-limited decode, one value per 10 ms frame."""
    af = []
    if hp:
        af.append("highpass=f=%d" % hp)
    if lp:
        af.append("lowpass=f=%d" % lp)
    raw = subprocess.run(
        ["ffmpeg", "-v", "quiet", "-i", path, "-ac", "1", "-ar", str(rate)]
        + (["-af", ",".join(af)] if af else [])
        + ["-f", "s16le", "-"],
        capture_output=True, check=True,
    ).stdout
    import array
    s = array.array("h")
    s.frombytes(raw)
    n = int(rate * FRAME)
    env = []
    for i in range(0, len(s) - n, n):
        acc = 0
        for v in s[i:i + n]:
            acc += v * v
        env.append((acc / n) ** 0.5)
    return env


def normalize(env):
    m = max(env) or 1.0
    return [v / m for v in env]


def onset_strength(env, frames=3):
    out = [0.0] * len(env)
    for i in range(frames, len(env)):
        out[i] = max(0.0, env[i] - env[i - frames])
    return out


def autocorr_tempo(flux):
    n = len(flux)
    mean = sum(flux) / n
    x = [v - mean for v in flux]
    lo = int(0.30 / FRAME)   # 200 BPM
    hi = int(0.90 / FRAME)   #  67 BPM
    best, best_bpm = -1e18, 0
    scores = {}
    for lag in range(lo, hi):
        s = 0.0
        for i in range(0, n - lag):
            s += x[i] * x[i + lag]
        s /= (n - lag)
        scores[lag] = s
        if s > best:
            best, best_bpm = s, 60.0 / (lag * FRAME)
    return best_bpm, scores


def peaks(env, thresh_pct=88, min_gap=0.09):
    if not env:
        return []
    s = sorted(env)
    thresh = s[int(len(s) * thresh_pct / 100)]
    out = []
    for i, v in enumerate(env):
        if v < thresh:
            continue
        t = i * FRAME
        if out and t - out[-1][0] < min_gap:
            if v > out[-1][1]:
                out[-1] = (t, v)
        else:
            out.append((t, v))
    return out


def main():
    path = sys.argv[1]
    args = dict(zip(sys.argv[2::2], sys.argv[3::2]))
    low = normalize(band_envelope(path, 800, 0, 160))
    mid = normalize(band_envelope(path, 4000, 160, 3000))
    dur = len(low) * FRAME
    print("track %s  duration %.2fs" % (path, dur))

    for name, env in (("low(0-160Hz)", low), ("mid(160-3k)", mid)):
        flux = onset_strength(env)
        bpm, _ = autocorr_tempo(flux)
        pk = peaks(flux)
        print("  %-14s tempo %.2f BPM  peaks %d" % (name, bpm, len(pk)))
        if len(pk) > 6:
            d = sorted(pk[i + 1][0] - pk[i][0] for i in range(len(pk) - 1))
            med = d[len(d) // 2]
            print("        median peak gap %.3fs -> %.2f BPM" % (med, 60 / med))
            print("        first peaks: " + " ".join("%.2f" % t for t, _ in pk[:24]))

    flux = onset_strength(low)
    pk = peaks(flux)
    if pk:
        print("  bar grid guess (4/4):")
        gaps = [pk[i + 1][0] - pk[i][0] for i in range(len(pk) - 1)]
        gaps = sorted(gaps)
        beat = gaps[len(gaps) // 2] if gaps else 0.5
        print("    beat %.3fs  bar %.3fs" % (beat, beat * 4))


if __name__ == "__main__":
    main()
