"""Safety checks for the pinned Catalog retention workflow; no remote calls."""
import importlib.util
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import MagicMock

from pyiceberg.expressions import LessThan
from pyiceberg.transforms import IdentityTransform, BucketTransform

spec = importlib.util.spec_from_file_location("platform_retention", Path(__file__).with_name("platform-retention.py"))
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


class RetentionSafety(TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 6, tzinfo=timezone.utc)
        self.table = MagicMock()
        self.catalog = MagicMock()
        self.catalog.load_table.return_value = self.table
        self.table.schema.return_value.find_field.return_value.field_id = 7
        self.table.spec.return_value.fields = [SimpleNamespace(source_id=7, transform=IdentityTransform())]
        self.table.current_snapshot.return_value.snapshot_id = 2
        self.table.refs.return_value = {"historical-restore": SimpleNamespace(snapshot_id=3)}
        self.table.snapshots.return_value = [
            SimpleNamespace(snapshot_id=1, timestamp_ms=0),
            SimpleNamespace(snapshot_id=2, timestamp_ms=0),
            SimpleNamespace(snapshot_id=3, timestamp_ms=0),
            SimpleNamespace(snapshot_id=4, timestamp_ms=int(self.now.timestamp() * 1000)),
        ]

    def test_deletes_through_catalog_and_preserves_current_referenced_and_recent_snapshots(self):
        retention.expire(self.catalog, "audit", "eventDate", 365, self.now)
        self.table.delete.assert_called_once_with(LessThan("eventDate", "2025-11-06"))
        operation = self.table.maintenance.expire_snapshots.return_value.__enter__.return_value
        operation.by_id.assert_called_once_with(1)
        self.table.refresh.assert_called_once()

    def test_refuses_non_identity_partitions_before_mutation(self):
        self.table.spec.return_value.fields = [SimpleNamespace(source_id=7, transform=BucketTransform(16))]
        with self.assertRaisesRegex(RuntimeError, "identity date partition"):
            retention.expire(self.catalog, "audit", "eventDate", 365, self.now)
        self.table.delete.assert_not_called()

    def test_failed_delete_does_not_expire_snapshots(self):
        self.table.delete.side_effect = RuntimeError("catalog commit failed")
        with self.assertRaisesRegex(RuntimeError, "catalog commit failed"):
            retention.expire(self.catalog, "heatmap", "weekDate", 90, self.now)
        self.table.maintenance.expire_snapshots.assert_not_called()


if __name__ == "__main__":
    main()
