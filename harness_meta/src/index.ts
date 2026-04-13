#!/usr/bin/env node

import chalk from 'chalk';
import { loadConfig } from './config.js';
import { Harness } from './orchestrator/harness.js';

async function main() {
  console.log(chalk.bold.cyan(`
╔══════════════════════════════════════════════╗
║    Harness Meta-Program v0.1.0               ║
║    Autonomous Multi-Agent Dev Framework      ║
╚══════════════════════════════════════════════╝
  `));

  try {
    const config = loadConfig();
    console.log(chalk.gray(`Model: ${config.llm.model}`));
    console.log(chalk.gray(`Target: ${config.paths.targetProject}`));
    console.log(chalk.gray(`Idea:   ${config.paths.ideaFile}`));
    console.log();

    const harness = new Harness(config);
    await harness.run();
  } catch (err) {
    console.error(chalk.red.bold('\nFatal Error:'), err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      console.error(chalk.gray(err.stack));
    }
    process.exit(1);
  }
}

main();
