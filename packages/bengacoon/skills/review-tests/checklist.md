# Test review checklist

- Does every changed behavior have a new or modified check when the project test mode writes tests?
- Would each check fail if the behavior it claims to protect were removed or broken?
- Does concurrent behavior start concurrently rather than await each operation in sequence?
- Does the check wait for an observable condition rather than a fixed delay?
- Does each fixture assert the value or state it depends on before using it?
- Is an assertion anchored on output that the code preserves rather than transforms or removes?
- Would `prove-red` remove the full changed mechanism rather than leave overlapping protection?
- Report each finding as `file:line — what would still pass`.
