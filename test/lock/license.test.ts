import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../src/core/model.js';
import {
  ALLOWLIST,
  LICENSE_FILE_NAMES,
  detectLicense,
  identifyLicenseText,
  isAllowed,
  licensePolicyDiagnostic,
} from '../../src/lock/license.js';
import { enc } from '../helpers/fs.js';

// Representative lines of the real standard texts, with their real line wrapping.
const MIT = `MIT License

Copyright (c) 2024 Example Author

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
`;

// Some MIT files wrap before "obtaining a copy".
const MIT_WRAPPED = `The MIT License (MIT)

Copyright (c) 2024 Example Author

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including without
limitation the rights to use, copy, modify, merge, publish, distribute,
`;

// The standard ISC text breaks "for any\npurpose" and "the above\ncopyright notice".
const ISC = `ISC License

Copyright (c) 2024, Example Author

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.
`;

const ZERO_BSD = `BSD Zero Clause License

Copyright (c) 2024 Example Author

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.
`;

const APACHE = `
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
`;

const BSD_2 = `BSD 2-Clause License

Copyright (c) 2024, Example Author

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
`;

const BSD_3 = `${BSD_2}
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.
`;

const CC0 = `Creative Commons Legal Code

CC0 1.0 Universal

    CREATIVE COMMONS CORPORATION IS NOT A LAW FIRM AND DOES NOT PROVIDE
`;

const CC_BY = `Attribution 4.0 International

=======================================================================

Creative Commons Corporation ("Creative Commons") is not a law firm and
`;

const GPL_2 = `                    GNU GENERAL PUBLIC LICENSE
                       Version 2, June 1991

 Copyright (C) 1989, 1991 Free Software Foundation, Inc.
`;

const GPL_3 = `                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007

 Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>
`;

const AGPL_3 = `                    GNU AFFERO GENERAL PUBLIC LICENSE
                       Version 3, 19 November 2007
`;

const LGPL_21 = `                  GNU LESSER GENERAL PUBLIC LICENSE
                       Version 2.1, February 1999
`;

const LGPL_3 = `                   GNU LESSER GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007
`;

function file(path: string, text: string): FileEntry {
  return { path, bytes: enc(text), executable: false };
}

describe('constants', () => {
  it('has the allowlist and the license file names, in order', () => {
    expect(ALLOWLIST).toEqual(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'CC0-1.0', 'CC-BY-4.0']);
    expect(LICENSE_FILE_NAMES).toEqual(['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']);
  });
});

describe('identifyLicenseText', () => {
  it('identifies each allowlisted text and the GPL family; random text is null', () => {
    expect(identifyLicenseText(MIT)).toBe('MIT');
    expect(identifyLicenseText(APACHE)).toBe('Apache-2.0');
    expect(identifyLicenseText(BSD_3)).toBe('BSD-3-Clause');
    expect(identifyLicenseText(BSD_2)).toBe('BSD-2-Clause');
    expect(identifyLicenseText(ISC)).toBe('ISC');
    expect(identifyLicenseText(CC0)).toBe('CC0-1.0');
    expect(identifyLicenseText(CC_BY)).toBe('CC-BY-4.0');
    expect(identifyLicenseText(GPL_3)).toBe('GPL-3.0');
    expect(identifyLicenseText('Do whatever you like with this.')).toBeNull();
    expect(identifyLicenseText('')).toBeNull();
  });

  it('maps the GNU family by qualifier and version', () => {
    expect(identifyLicenseText(GPL_2)).toBe('GPL-2.0');
    expect(identifyLicenseText(GPL_3)).toBe('GPL-3.0');
    expect(identifyLicenseText(AGPL_3)).toBe('AGPL-3.0');
    expect(identifyLicenseText(LGPL_21)).toBe('LGPL-2.1');
    expect(identifyLicenseText(LGPL_3)).toBe('LGPL-3.0');
  });

  it('returns null for GNU combinations that have no mapping', () => {
    expect(identifyLicenseText('GNU AFFERO GENERAL PUBLIC LICENSE\n Version 2, June 1991')).toBeNull();
    expect(identifyLicenseText('GNU LESSER GENERAL PUBLIC LICENSE\n Version 1, February 1999')).toBeNull();
    expect(identifyLicenseText('GNU GENERAL PUBLIC LICENSE\n Version 1, February 1989')).toBeNull();
    expect(identifyLicenseText('GNU LIBRARY GENERAL PUBLIC LICENSE\n Version 2, June 1991')).toBeNull();
  });

  it('matches the GNU family case-insensitively', () => {
    expect(identifyLicenseText('gnu general public license version 3')).toBe('GPL-3.0');
    expect(identifyLicenseText('Gnu Lesser General Public License\nVersion 2.1')).toBe('LGPL-2.1');
  });

  it('distinguishes BSD-2-Clause from BSD-3-Clause by the "Neither the name" clause', () => {
    expect(identifyLicenseText(BSD_2)).toBe('BSD-2-Clause');
    expect(identifyLicenseText(BSD_3)).toBe('BSD-3-Clause');
  });

  it('ISC requires the notice clause (0BSD-like text is null)', () => {
    expect(identifyLicenseText(ZERO_BSD)).toBeNull();
  });

  it('requires both parts of the two-part matches', () => {
    expect(identifyLicenseText('Apache License')).toBeNull();
    expect(identifyLicenseText('Version 2.0')).toBeNull();
    expect(identifyLicenseText('Neither the name of the copyright holder')).toBeNull();
  });

  it('identifies the real line-wrapped standard MIT, ISC and Apache-2.0 texts', () => {
    expect(MIT).toContain('to any person obtaining a copy\nof this software');
    expect(identifyLicenseText(MIT)).toBe('MIT');
    expect(identifyLicenseText(MIT_WRAPPED)).toBe('MIT');
    expect(ISC).toContain('for any\npurpose');
    expect(identifyLicenseText(ISC)).toBe('ISC');
    expect(APACHE).toContain('Apache License\n');
    expect(identifyLicenseText(APACHE)).toBe('Apache-2.0');
  });

  it('collapses every run of whitespace, including CR, LF, tabs and indentation', () => {
    expect(identifyLicenseText(MIT.replace(/\n/g, '\r\n'))).toBe('MIT');
    expect(identifyLicenseText(ISC.replace(/\n/g, '\r\n'))).toBe('ISC');
    expect(identifyLicenseText(MIT_WRAPPED.replace(/ /g, '  '))).toBe('MIT');
    expect(identifyLicenseText(MIT.replace(/ /g, '\t'))).toBe('MIT');
    expect(identifyLicenseText(GPL_3.replace(/\n/g, '\r\n'))).toBe('GPL-3.0');
  });

  it('strips a leading UTF-8 BOM', () => {
    expect(identifyLicenseText(`\uFEFF${MIT}`)).toBe('MIT');
    expect(identifyLicenseText(`\uFEFF${GPL_3}`)).toBe('GPL-3.0');
  });

  it('keeps the literal phrases case-sensitive', () => {
    expect(identifyLicenseText(MIT.toUpperCase())).toBeNull();
    expect(identifyLicenseText(MIT.replace('Permission is hereby granted', 'permission is hereby granted'))).toBeNull();
    expect(identifyLicenseText(ISC.toLowerCase())).toBeNull();
  });
});

describe('detectLicense', () => {
  it('order: asserted > frontmatter > skill-file > repo-root', () => {
    const skillFiles = [file('LICENSE', MIT)];
    const repoRootFiles = [file('LICENSE', APACHE)];

    expect(
      detectLicense({ assertion: { spdx: 'MIT' }, frontmatterLicense: 'Apache-2.0', skillFiles, repoRootFiles }),
    ).toEqual({ license: 'MIT', from: 'asserted', file: null });
    expect(detectLicense({ frontmatterLicense: 'ISC', skillFiles, repoRootFiles })).toEqual({
      license: 'ISC',
      from: 'frontmatter',
      file: null,
    });
    expect(detectLicense({ skillFiles, repoRootFiles })).toEqual({
      license: 'MIT',
      from: 'skill-file',
      file: 'LICENSE',
    });
    expect(detectLicense({ skillFiles: [], repoRootFiles })).toEqual({
      license: 'Apache-2.0',
      from: 'repo-root',
      file: 'LICENSE',
    });
  });

  it('returns an asserted license as-is, without validating it', () => {
    expect(detectLicense({ assertion: { spdx: 'GPL-3.0' }, skillFiles: [], repoRootFiles: [] })).toEqual({
      license: 'GPL-3.0',
      from: 'asserted',
      file: null,
    });
    expect(detectLicense({ assertion: { spdx: 'Not-An-Id' }, skillFiles: [], repoRootFiles: [] })).toEqual({
      license: 'Not-An-Id',
      from: 'asserted',
      file: null,
    });
  });

  it('uses a frontmatter license that is an allowlisted id or a GPL-family id', () => {
    for (const id of [...ALLOWLIST, 'GPL-3.0', 'GPL-2.0-only', 'AGPL-3.0', 'LGPL-2.1']) {
      expect(detectLicense({ frontmatterLicense: id, skillFiles: [], repoRootFiles: [] })).toEqual({
        license: id,
        from: 'frontmatter',
        file: null,
      });
    }
  });

  it('falls through when the frontmatter license is free text or another id', () => {
    const skillFiles = [file('LICENSE.txt', MIT)];
    for (const value of ['Complete terms in LICENSE.txt', 'mit', 'GPLv3', 'Proprietary', 'Unlicense', '']) {
      expect(detectLicense({ frontmatterLicense: value, skillFiles, repoRootFiles: [] })).toEqual({
        license: 'MIT',
        from: 'skill-file',
        file: 'LICENSE.txt',
      });
    }
  });

  it('falls through when the frontmatter license is not a string', () => {
    const skillFiles = [file('LICENSE', MIT)];
    for (const value of [undefined, null, 42, true, ['MIT'], { spdx: 'MIT' }]) {
      expect(detectLicense({ frontmatterLicense: value, skillFiles, repoRootFiles: [] })).toEqual({
        license: 'MIT',
        from: 'skill-file',
        file: 'LICENSE',
      });
    }
  });

  it('frontmatter free text + skill LICENSE.txt (MIT) is the skill-file license', () => {
    expect(
      detectLicense({
        frontmatterLicense: 'Complete terms in LICENSE.txt',
        skillFiles: [file('SKILL.md', '---\n---\n'), file('LICENSE.txt', MIT)],
        repoRootFiles: [],
      }),
    ).toEqual({ license: 'MIT', from: 'skill-file', file: 'LICENSE.txt' });
  });

  it('no skill license file: the repo-root LICENSE (Apache) is used', () => {
    expect(
      detectLicense({
        skillFiles: [file('SKILL.md', 'x')],
        repoRootFiles: [file('README.md', 'x'), file('LICENSE', APACHE)],
      }),
    ).toEqual({ license: 'Apache-2.0', from: 'repo-root', file: 'LICENSE' });
  });

  it('nothing found is unknown', () => {
    expect(detectLicense({ skillFiles: [], repoRootFiles: [] })).toEqual({ license: null, from: null, file: null });
    expect(
      detectLicense({ skillFiles: [file('SKILL.md', 'x')], repoRootFiles: [file('README.md', 'x')] }),
    ).toEqual({ license: null, from: null, file: null });
  });

  it('looks license files up in LICENSE_FILE_NAMES order, not in input order', () => {
    expect(
      detectLicense({
        skillFiles: [file('COPYING', APACHE), file('LICENSE.txt', ISC), file('LICENSE.md', MIT)],
        repoRootFiles: [],
      }),
    ).toEqual({ license: 'MIT', from: 'skill-file', file: 'LICENSE.md' });
    expect(
      detectLicense({
        skillFiles: [],
        repoRootFiles: [file('COPYING', GPL_3), file('LICENSE.txt', BSD_2)],
      }),
    ).toEqual({ license: 'BSD-2-Clause', from: 'repo-root', file: 'LICENSE.txt' });
    expect(
      detectLicense({ skillFiles: [file('COPYING', BSD_3), file('LICENSE', ISC)], repoRootFiles: [] }),
    ).toEqual({ license: 'ISC', from: 'skill-file', file: 'LICENSE' });
  });

  it('matches only top-level entries with the exact file name', () => {
    expect(
      detectLicense({
        skillFiles: [file('docs/LICENSE', MIT), file('license', MIT), file('LICENSE.rst', MIT), file('LICENSE/x', MIT)],
        repoRootFiles: [file('docs/LICENSE', APACHE), file('licence.txt', APACHE)],
      }),
    ).toEqual({ license: null, from: null, file: null });
  });

  it('a skill license file with unrecognized text ends detection as unknown (no fall-through to the repo root)', () => {
    expect(
      detectLicense({
        skillFiles: [file('LICENSE', 'All rights reserved. Do not copy.')],
        repoRootFiles: [file('LICENSE', MIT)],
      }),
    ).toEqual({ license: null, from: 'skill-file', file: 'LICENSE' });
  });

  it('an unrecognized earlier-named skill file wins over a recognized later-named one', () => {
    expect(
      detectLicense({
        skillFiles: [file('LICENSE.md', 'Custom terms.'), file('COPYING', MIT)],
        repoRootFiles: [],
      }),
    ).toEqual({ license: null, from: 'skill-file', file: 'LICENSE.md' });
  });

  it('a repo-root license file with unrecognized text is unknown', () => {
    expect(
      detectLicense({ skillFiles: [], repoRootFiles: [file('COPYING', 'Custom terms.')] }),
    ).toEqual({ license: null, from: 'repo-root', file: 'COPYING' });
  });

  it('decodes license files as UTF-8, tolerating a BOM and CRLF', () => {
    const bytes = enc(`\uFEFF${MIT.replace(/\n/g, '\r\n')}`);
    expect(bytes.slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(
      detectLicense({ skillFiles: [{ path: 'LICENSE', bytes, executable: false }], repoRootFiles: [] }),
    ).toEqual({ license: 'MIT', from: 'skill-file', file: 'LICENSE' });
  });
});

describe('isAllowed', () => {
  it('accepts exactly the allowlisted ids', () => {
    for (const id of ALLOWLIST) expect(isAllowed(id)).toBe(true);
    expect(isAllowed('MIT')).toBe(true);
    expect(isAllowed('GPL-3.0')).toBe(false);
    expect(isAllowed('mit')).toBe(false);
    expect(isAllowed('MIT ')).toBe(false);
    expect(isAllowed('')).toBe(false);
  });
});

describe('licensePolicyDiagnostic', () => {
  it('is undefined for an allowlisted license', () => {
    expect(licensePolicyDiagnostic('p', 'x', { license: 'MIT', file: 'LICENSE' }, 'fix it')).toBeUndefined();
  });

  it('LICENSE-UNKNOWN names the license file and ends with the remedy', () => {
    expect(licensePolicyDiagnostic('skills/x/SKILL.md', 'x', { license: null, file: 'LICENSE.txt' }, 'fix it')).toEqual({
      path: 'skills/x/SKILL.md',
      severity: 'error',
      rule: 'LICENSE-UNKNOWN',
      message: '"x": license could not be determined (LICENSE.txt is not a recognized license text); fix it',
    });
  });

  it('LICENSE-UNKNOWN without a license file has no note', () => {
    expect(licensePolicyDiagnostic('p', 'src/x', { license: null, file: null }, 'fix it')).toMatchObject({
      rule: 'LICENSE-UNKNOWN',
      message: '"src/x": license could not be determined; fix it',
    });
  });

  it('LICENSE-DISALLOWED names the license and the allowlist', () => {
    expect(licensePolicyDiagnostic('ronin.lock', 'src/x', { license: 'GPL-3.0', file: null }, 'fix it')).toEqual({
      path: 'ronin.lock',
      severity: 'error',
      rule: 'LICENSE-DISALLOWED',
      message:
        '"src/x": license GPL-3.0 is not on the allowlist ' +
        '(MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, CC0-1.0, CC-BY-4.0)',
    });
  });
});
