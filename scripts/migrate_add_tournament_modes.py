#!/usr/bin/env python3
"""Migrates existing tournament JSON files in S3 to the tournament-modes/rounds schema.

Adds, to each tournament object that predates the ladder/swiss/swiss_with_challenge feature:
  - `mode: "ladder"` on the tournament itself
  - `roundCount: null` on the tournament
  - `rounds: []` on the tournament
  - `round: null` on each of its challenges

Unlike the roster-validation migration, this one isn't just cosmetic: several backend code
paths read `tournament.rounds.length` or `challenge.round` unconditionally. A tournament
missing these fields will make those endpoints throw (e.g. registering a new team, creating a
challenge) — so running this script is required, not optional, for any tournament created
before this feature shipped.

Idempotent and safe to run against a live bucket: each write is a conditional PUT (If-Match on
the object's current ETag), so if the live app modifies a tournament between our GET and PUT,
that write is skipped with a warning instead of silently clobbering the concurrent change — just
re-run the script to pick it up.

Usage:
  pip install -r requirements.txt
  python3 migrate_add_tournament_modes.py --bucket <data-bucket-name> [--dry-run]
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


def migrate_tournament(data: dict) -> bool:
    """Mutates `data` in place to add any missing mode/round fields.

    Returns True if anything changed (i.e. the object needs to be written back).
    """
    changed = False

    if "mode" not in data:
        data["mode"] = "ladder"
        changed = True

    if "roundCount" not in data:
        data["roundCount"] = None
        changed = True

    if "rounds" not in data:
        data["rounds"] = []
        changed = True

    for challenge in data.get("challenges", []):
        if "round" not in challenge:
            challenge["round"] = None
            changed = True

    return changed


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

            if not migrate_tournament(data):
                already_ok += 1
                continue

            tournament_id = data.get("id", key)

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
    if skipped_conflict:
        print(f"Skipped (conflict): {skipped_conflict} — re-run the script to retry these")

    return 1 if skipped_conflict else 0


if __name__ == "__main__":
    sys.exit(main())
