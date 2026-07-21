import {
  COMMAND_CATALOG,
  findCommandDefinition,
  renderCommandHelp,
  renderTopLevelHelp,
} from '../src/catalog.js';

describe('command catalog', () => {
  it('is unique and renders every command with complete documentation', () => {
    const paths = COMMAND_CATALOG.map((definition) => definition.path.join(' '));
    expect(new Set(paths).size).toBe(paths.length);
    for (const definition of COMMAND_CATALOG) {
      expect(findCommandDefinition(definition.path)).toBe(definition);
      const help = renderCommandHelp(definition);
      expect(help).toContain(`Usage: ${definition.usage}`);
      expect(help).toContain(definition.description);
      expect(help).toContain('Examples:');
      expect(help).toContain(`Output: ${definition.output}`);
      expect(help).toContain(`Exit codes: ${definition.exitCodes.join(', ')}`);
    }
  });

  it('lists every top-level command in top-level help', () => {
    const help = renderTopLevelHelp();
    for (const group of new Set(COMMAND_CATALOG.map((definition) => definition.path[0]))) {
      expect(help).toContain(`  ${group}`);
    }
  });
});
