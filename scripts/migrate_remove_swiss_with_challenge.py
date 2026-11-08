#!/usr/bin/env python3
"""Migrates tournaments still using the removed `swiss_with_challenge` mode to plain `swiss`.

The "Rondes suisses avec défis en 1ère ronde" format was removed (organizers can force round-1
pairings from the admin interface instead). Once the code without it is deployed, a tournament
still stored with `mode: "swiss_with_challenge"` has an unknown mode: no format label, and round 1
can no longer be redrawn. This script switches those tournaments to `mode: "swiss"` and drops the
now-unused `fixedChallengeIds` from their rounds.

Pre-round free challenges (`round: null`) can't exist in a swiss tournament. A tournament that
still has some is reported and left untouched, to be handled by hand.

Idempotent and safe to run against a live bucket: each write is a conditional PUT (If-Match on
the object's current ETag), so if the live app modifies a tournament between our GET and PUT,
that write is skipped with a warning instead of silently clobbering the concurrent change — just
re-run the script to pick it up.

Usage:
  pip install -r requirements.txt
  python3 migrate_remove_swiss_with_challenge.py --bucket <data-bucket-name> [--dry-run]
                                                 [--profile <aws-profile>] [--region <aws-region>]

Find the data bucket name (the CDK stack's `DataBucketName` output, not the roster-images
assets bucket):
  aws cloudformation describe-stacks --stack-name BbTournamentStack \\
    --query "Stacks[0].Outputs[?OutputKey=='DataBucketName'].OutputValue" --output text
"""

import argparse
import json
import sys

import boto3
from botocore.exceptions import ClientError

PREFIX = "tournaments/"
OLD_MODE = "swiss_with_challenge"


def free_challenges(data: dict) -> list:
    return [c for c in data.get("challenges", []) if c.get("round") is None]


def migrate_tournament(data: dict) -> bool:
    """Mutates `data` in place to switch it to plain swiss mode.

    Returns True if anything changed (i.e. the object needs to be written back).
    """
    if data.get("mode") != OLD_MODE:
        return False

    data["mode"] = "swiss"
    for round_info in data.get("rounds", []):
        round_info.pop("fixedChallengeIds", None)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--bucket", required=True, help="S3 data bucket holding tournament JSON files"
    )
    parser.add_argument("--profile", default=None, help="AWS CLI profile to use")
    parser.add_argument("--region", default=None, help="AWS region")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing anything",
    )
    args = parser.parse_args()

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    s3 = session.client("s3")

    scanned = 0
    updated = 0
    already_ok = 0
    skipped_conflict = 0
    skipped_free = 0

    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=args.bucket, Prefix=PREFIX):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.endswith(".json"):
                continue
            scanned += 1

            resp = s3.get_object(Bucket=args.bucket, Key=key)
            etag = resp["ETag"]
            data = json.loads(resp["Body"].read())
            tournament_id = data.get("id", key)

            if data.get("mode") == OLD_MODE and free_challenges(data):
                print(
                    f"SKIPPED {key} (tournament {tournament_id}): "
                    f"{len(free_challenges(data))} free challenge(s) to handle by hand",
                    file=sys.stderr,
                )
                skipped_free += 1
                continue

            if not migrate_tournament(data):
                already_ok += 1
                continue

            if args.dry_run:
                print(f"[dry-run] would update {key} (tournament {tournament_id})")
                updated += 1
                continue

            try:
                s3.put_object(
                    Bucket=args.bucket,
                    Key=key,
                    Body=json.dumps(data).encode("utf-8"),
                    ContentType="application/json",
                    IfMatch=etag,
                )
                print(f"updated {key} (tournament {tournament_id})")
                updated += 1
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code", "")
                if code in ("PreconditionFailed", "412"):
                    print(
                        f"SKIPPED {key}: modified concurrently, re-run the script to retry",
                        file=sys.stderr,
                    )
                    skipped_conflict += 1
                else:
                    raise

    verb = "Would update" if args.dry_run else "Updated"
    print()
    print(f"Scanned:            {scanned}")
    print(f"Already up to date: {already_ok}")
    print(f"{verb}:{' ' * (19 - len(verb))}{updated}")
    if skipped_free:
        print(f"Skipped (free challenges): {skipped_free} — fix these by hand")
    if skipped_conflict:
        print(f"Skipped (conflict): {skipped_conflict} — re-run the script to retry these")

    return 1 if skipped_conflict or skipped_free else 0


if __name__ == "__main__":
    sys.exit(main())
