"""Expire only configured Iceberg partitions through the Catalog transaction API.

No direct R2 deletes: Catalog snapshot maintenance owns physical file cleanup.
"""
import os
from datetime import datetime, timedelta, timezone

from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.expressions import LessThan
from pyiceberg.transforms import IdentityTransform


def expire(catalog, identifier, column, days, now):
    table = catalog.load_table(identifier)
    field = table.schema().find_field(column)
    if not any(part.source_id == field.field_id and isinstance(part.transform, IdentityTransform)
               for part in table.spec().fields):
        raise RuntimeError(f"{identifier} requires an identity date partition on {column}")
    cutoff = (now - timedelta(days=days)).date().isoformat()
    # An expression object prevents configuration from becoming executable SQL.
    table.delete(LessThan(column, cutoff))
    table.refresh()
    # Retain all references and the latest snapshot. Basin Catalog's automatic
    # expiration subsequently removes unreferenced files; never unlink R2 keys.
    current = table.current_snapshot()
    keep = {ref.snapshot_id for ref in table.refs().values()}
    if current:
        keep.add(current.snapshot_id)
    older_than = int((now - timedelta(days=2)).timestamp() * 1000)
    eligible = [snapshot.snapshot_id for snapshot in table.snapshots()
                if snapshot.timestamp_ms < older_than and snapshot.snapshot_id not in keep]
    if eligible:
        with table.maintenance.expire_snapshots() as operation:
            for snapshot_id in eligible:
                operation.by_id(snapshot_id)
    print(f"{identifier}: retention committed through {cutoff}; {len(eligible)} old snapshots expired")


def main():
    catalog = RestCatalog(name="noteflare_retention", uri=os.environ["BASIN_CATALOG_URI"],
                          warehouse=os.environ["BASIN_WAREHOUSE"], token=os.environ["BASIN_CATALOG_TOKEN"])
    now = datetime.now(timezone.utc)
    expire(catalog, os.environ["BASIN_AUDIT_TABLE"], "eventDate", 365, now)
    expire(catalog, os.environ["BASIN_HEATMAP_TABLE"], "weekDate", 90, now)


if __name__ == "__main__":
    main()
