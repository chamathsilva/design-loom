# Item status vocabulary

## Purpose

Define the status vocabulary used by catalog interfaces.

## Producer and consumers

Catalog write operations produce status values. Dashboard and CRUD readers consume them.

## Contract

The status values are `active` and `archived`. Public listings omit archived items.

## Version compatibility

A new status value requires an explicit contract amendment and impact review.

## Failure behavior

An unknown status is a contract error and must be reported explicitly.

## Ownership

The application engineering role owns the vocabulary. QA reviews its behavior when bound into a workstream proposal.
