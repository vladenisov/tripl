"""SemVer-aware helpers for app version ordering."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from functools import cmp_to_key

_SEMVER_RE = re.compile(
    r"^[vV]?"
    r"(?P<major>0|[1-9]\d*)"
    r"\.(?P<minor>0|[1-9]\d*)"
    r"\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+(?P<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"$"
)
_NUMERIC_IDENTIFIER_RE = re.compile(r"^(0|[1-9]\d*)$")

# How many latest releases (by SemVer order) to retain as explicit series in
# app-version breakdowns; older releases roll up into the shared "Other" bucket.
# Retention is applied at READ time over the full requested window so the kept
# set stays stable regardless of how collection was chunked.
DEFAULT_APP_VERSION_KEEP_RELEASES = 5
# Bound project configuration so accidental or hostile inputs cannot request an
# impractically large number of chart series or overflow the database integer.
MAX_APP_VERSION_KEEP_RELEASES = 100
# Display label for releases outside the retained window.
APP_VERSION_OTHER_LABEL = "Other"


@dataclass(frozen=True)
class PrereleaseIdentifier:
    raw: str
    numeric: int | None

    @property
    def is_numeric(self) -> bool:
        return self.numeric is not None


@dataclass(frozen=True)
class ParsedVersion:
    raw: str
    normalized: str
    is_semver: bool
    major: int | None
    minor: int | None
    patch: int | None
    prerelease: tuple[PrereleaseIdentifier, ...]
    build: tuple[str, ...]

    @property
    def release(self) -> tuple[int, int, int] | None:
        if self.major is None or self.minor is None or self.patch is None:
            return None
        return (self.major, self.minor, self.patch)


def parse_version(version: str) -> ParsedVersion:
    """Parse a version string into a SemVer key or a lexical fallback key."""
    normalized = version.strip()
    match = _SEMVER_RE.fullmatch(normalized)
    if match is None:
        return _fallback_version(version, normalized)

    prerelease = _parse_prerelease(match.group("prerelease"))
    if prerelease is None:
        return _fallback_version(version, normalized)

    build = match.group("build")
    return ParsedVersion(
        raw=version,
        normalized=normalized,
        is_semver=True,
        major=int(match.group("major")),
        minor=int(match.group("minor")),
        patch=int(match.group("patch")),
        prerelease=prerelease,
        build=tuple(build.split(".")) if build is not None else (),
    )


def compare_versions(left: str, right: str) -> int:
    """Compare two version strings.

    Returns -1 when ``left < right``, 1 when ``left > right``, and 0 when both
    values have the same SemVer precedence or the same lexical fallback value.
    Valid SemVer values sort after non-SemVer fallbacks.
    """
    return _compare_parsed(parse_version(left), parse_version(right), total=False)


def order_versions(versions: Iterable[str], *, reverse: bool = False) -> list[str]:
    """Return versions ordered by SemVer precedence with lexical fallback."""
    return sorted(versions, key=cmp_to_key(_compare_version_strings_total), reverse=reverse)


def latest_version(versions: Iterable[str]) -> str | None:
    """Return the latest distinct version from an iterable, if present."""
    latest, _previous = latest_previous_versions(versions)
    return latest


def is_prerelease(version: str) -> bool:
    """True when ``version`` parses as SemVer with a non-empty prerelease tag.

    A prerelease build (e.g. ``"3.0.0-beta.1"`` / ``"2.1.0-rc.2"``) is a
    dev/tester artifact that must never be treated as the latest/active release.
    Non-SemVer strings have no prerelease component and so are never prereleases.
    """
    return bool(parse_version(version).prerelease)


def latest_previous_versions(versions: Iterable[str]) -> tuple[str | None, str | None]:
    """Return the latest and previous distinct precedence versions.

    Duplicate raw values are ignored. If multiple SemVer strings share the same
    precedence, such as build metadata variants, the latest value is selected by
    deterministic lexical tie-breaker and the previous value skips that equal
    precedence group.
    """
    distinct = _distinct_versions(versions)
    if not distinct:
        return None, None

    ordered = order_versions(distinct)
    latest = ordered[-1]
    previous = next(
        (
            candidate
            for candidate in reversed(ordered[:-1])
            if compare_versions(candidate, latest) != 0
        ),
        None,
    )
    return latest, previous


def _fallback_version(raw: str, normalized: str) -> ParsedVersion:
    return ParsedVersion(
        raw=raw,
        normalized=normalized,
        is_semver=False,
        major=None,
        minor=None,
        patch=None,
        prerelease=(),
        build=(),
    )


def _parse_prerelease(raw: str | None) -> tuple[PrereleaseIdentifier, ...] | None:
    if raw is None:
        return ()

    identifiers: list[PrereleaseIdentifier] = []
    for identifier in raw.split("."):
        if identifier.isdigit():
            if _NUMERIC_IDENTIFIER_RE.fullmatch(identifier) is None:
                return None
            identifiers.append(PrereleaseIdentifier(raw=identifier, numeric=int(identifier)))
        else:
            identifiers.append(PrereleaseIdentifier(raw=identifier, numeric=None))
    return tuple(identifiers)


def _compare_version_strings_total(left: str, right: str) -> int:
    return _compare_parsed(parse_version(left), parse_version(right), total=True)


def _compare_parsed(left: ParsedVersion, right: ParsedVersion, *, total: bool) -> int:
    if left.is_semver and right.is_semver:
        result = _compare_semver(left, right)
        if result != 0 or not total:
            return result
        return _compare_text(left.normalized, right.normalized) or _compare_text(
            left.raw,
            right.raw,
        )

    if left.is_semver != right.is_semver:
        return 1 if left.is_semver else -1

    result = _compare_text(left.normalized, right.normalized)
    if result != 0 or not total:
        return result
    return _compare_text(left.raw, right.raw)


def _compare_semver(left: ParsedVersion, right: ParsedVersion) -> int:
    left_release = left.release
    right_release = right.release
    if left_release is None or right_release is None:
        msg = "SemVer comparison requires parsed release components"
        raise ValueError(msg)

    result = _compare_tuple(left_release, right_release)
    if result != 0:
        return result
    return _compare_prerelease(left.prerelease, right.prerelease)


def _compare_prerelease(
    left: tuple[PrereleaseIdentifier, ...],
    right: tuple[PrereleaseIdentifier, ...],
) -> int:
    if not left and not right:
        return 0
    if not left:
        return 1
    if not right:
        return -1

    for left_part, right_part in zip(left, right, strict=False):
        if left_part.is_numeric and right_part.is_numeric:
            result = _compare_int(left_part.numeric, right_part.numeric)
        elif left_part.is_numeric:
            result = -1
        elif right_part.is_numeric:
            result = 1
        else:
            result = _compare_text(left_part.raw, right_part.raw)
        if result != 0:
            return result

    return _compare_int(len(left), len(right))


def _compare_tuple(left: tuple[int, ...], right: tuple[int, ...]) -> int:
    for left_part, right_part in zip(left, right, strict=True):
        result = _compare_int(left_part, right_part)
        if result != 0:
            return result
    return 0


def _compare_int(left: int | None, right: int | None) -> int:
    if left == right:
        return 0
    if left is None:
        return -1
    if right is None:
        return 1
    return -1 if left < right else 1


def _compare_text(left: str, right: str) -> int:
    if left == right:
        return 0
    return -1 if left < right else 1


def _distinct_versions(versions: Iterable[str]) -> list[str]:
    distinct: list[str] = []
    seen: set[str] = set()
    for version in versions:
        key = version.strip()
        if key in seen:
            continue
        seen.add(key)
        distinct.append(version)
    return distinct
