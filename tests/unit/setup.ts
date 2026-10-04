// Shared vitest setup. Storage tests import 'fake-indexeddb/auto' themselves so
// parser tests stay free of DOM globals.
import { expect } from 'vitest';

expect.extend({});
