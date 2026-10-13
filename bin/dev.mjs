#!/usr/bin/env node
import { main, reportCliError } from '../src/cli.ts';
await main().catch(reportCliError);
