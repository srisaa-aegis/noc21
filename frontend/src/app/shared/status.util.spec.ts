import { applTypePresentation, statusPresentation } from './status.util';

describe('statusPresentation', () => {
  it('maps every documented status id (1-9) to a label and class', () => {
    const expected: Record<number, string> = {
      1: 'Draft',
      2: 'Submitted',
      3: 'Inspected',
      4: 'Reviewed (ADFS)',
      5: 'Reviewed (DFS-CD)',
      6: 'Pending Final Approval',
      7: 'Approved',
      8: 'Returned with Comments',
      9: 'Rejected',
    };
    for (const [id, label] of Object.entries(expected)) {
      const presentation = statusPresentation(Number(id) as never);
      expect(presentation.label).toBe(label);
      expect(presentation.className).toMatch(/^status--/);
    }
  });
});

describe('applTypePresentation', () => {
  it('maps each application type code to a label and icon', () => {
    expect(applTypePresentation('P').label).toBe('Provisional');
    expect(applTypePresentation('O').icon).toBe('login');
    expect(applTypePresentation('D').label).toBe('Declaration');
  });
});
