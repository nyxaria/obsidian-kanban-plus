# Test Global Tag Symbols

This file tests the global tag symbols feature.

## Tags to test:

- #business - should show configured symbol
- #personal - should show configured symbol  
- #urgent - should show configured symbol
- #completed - should show configured symbol
- #project/work - nested tag test
- #project/home - another nested tag

## In different contexts:

Some text with #business tag inline.

A list item with #personal tag.

> A blockquote with #urgent tag.

**Bold text** with #completed tag.

## Multiple tags:

This line has #business #personal #urgent tags together.

## Nested tags:

Working on #project/work items and #project/home tasks.

## Test in editing mode:

When you edit this file, the tags should show symbols in the CodeMirror editor as well.

## Test in reading mode:

When you view this file in reading mode, the tags should show symbols before the tag text. 