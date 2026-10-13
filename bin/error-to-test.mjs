#!/usr/bin/env node
import { main, reportCliError } from '../dist/cli.js';
await main().catch(reportCliError);
