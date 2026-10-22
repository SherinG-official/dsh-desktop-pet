'use strict';

/**
 * Thin shim so the pet can be started as its own Electron app in a dev checkout:
 *
 *   npm run pet                    -> electron pet-app --pet --dev
 *
 * The implementation lives in ../src/pet.js, which the installed app also reaches
 * by relaunching its own executable with --pet (see src/main.js). Keeping one
 * implementation is what lets the same code run in both layouts.
 */

const { run } = require('../src/pet');

run();
