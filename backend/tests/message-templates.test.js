/**
 * Unit tests for Message Templates
 * Tests TipTap JSON generation for Circle.so DM integration
 *
 * Epic 4: Profile Photo Enforcement System
 */

const {
  textToTipTap,
  warning1,
  warning2,
  warning3,
  finalWarning,
  thankYouMessage,
  adminAlert,
  getWarningMessage
} = require('../netlify/functions/utils/message-templates');

describe('Message Templates - TipTap JSON Generation', () => {
  describe('textToTipTap - Plain Text to TipTap Converter', () => {
    it('should convert simple single paragraph', () => {
      const result = textToTipTap('Hello world');

      expect(result).toEqual({
        body: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Hello world' }
              ]
            }
          ]
        }
      });
    });

    it('should convert multiple paragraphs separated by blank lines', () => {
      const result = textToTipTap('First paragraph\n\nSecond paragraph');

      expect(result.body.content).toHaveLength(2);
      expect(result.body.content[0].type).toBe('paragraph');
      expect(result.body.content[1].type).toBe('paragraph');
    });

    it('should convert line breaks within paragraph to hardBreak nodes', () => {
      const result = textToTipTap('Line 1\nLine 2\nLine 3');

      const paragraph = result.body.content[0];
      expect(paragraph.content).toHaveLength(5); // text, break, text, break, text

      expect(paragraph.content[0]).toEqual({ type: 'text', text: 'Line 1' });
      expect(paragraph.content[1]).toEqual({ type: 'hardBreak' });
      expect(paragraph.content[2]).toEqual({ type: 'text', text: 'Line 2' });
      expect(paragraph.content[3]).toEqual({ type: 'hardBreak' });
      expect(paragraph.content[4]).toEqual({ type: 'text', text: 'Line 3' });
    });

    it('should convert **bold** text to marked text nodes', () => {
      const result = textToTipTap('This is **bold** text');

      const paragraph = result.body.content[0];
      expect(paragraph.content).toHaveLength(3);

      expect(paragraph.content[0]).toEqual({ type: 'text', text: 'This is ' });
      expect(paragraph.content[1]).toEqual({
        type: 'text',
        marks: [{ type: 'bold' }],
        text: 'bold'
      });
      expect(paragraph.content[2]).toEqual({ type: 'text', text: ' text' });
    });

    it('should handle multiple bold sections in one line', () => {
      const result = textToTipTap('**First** and **second** bold');

      const paragraph = result.body.content[0];
      expect(paragraph.content[0]).toEqual({
        type: 'text',
        marks: [{ type: 'bold' }],
        text: 'First'
      });
      expect(paragraph.content[2]).toEqual({
        type: 'text',
        marks: [{ type: 'bold' }],
        text: 'second'
      });
    });

    it('should convert *italic* text to marked text nodes', () => {
      const result = textToTipTap('This is *italic* text');

      const paragraph = result.body.content[0];
      expect(paragraph.content).toHaveLength(3);

      expect(paragraph.content[0]).toEqual({ type: 'text', text: 'This is ' });
      expect(paragraph.content[1]).toEqual({
        type: 'text',
        marks: [{ type: 'italic' }],
        text: 'italic'
      });
      expect(paragraph.content[2]).toEqual({ type: 'text', text: ' text' });
    });

    it('should handle multiple italic sections in one line', () => {
      const result = textToTipTap('*first* and *second* italic');

      const paragraph = result.body.content[0];
      expect(paragraph.content[0]).toEqual({
        type: 'text',
        marks: [{ type: 'italic' }],
        text: 'first'
      });
      expect(paragraph.content[2]).toEqual({
        type: 'text',
        marks: [{ type: 'italic' }],
        text: 'second'
      });
    });

    it('should handle **bold** and *italic* in the same line', () => {
      const result = textToTipTap('**bold** and *italic* text');

      const paragraph = result.body.content[0];
      expect(paragraph.content[0]).toEqual({
        type: 'text',
        marks: [{ type: 'bold' }],
        text: 'bold'
      });
      expect(paragraph.content[2]).toEqual({
        type: 'text',
        marks: [{ type: 'italic' }],
        text: 'italic'
      });
    });

    it('should convert [text](url) links to TipTap link marks', () => {
      const result = textToTipTap('Visit [our site](https://example.com) today');

      const paragraph = result.body.content[0];
      expect(paragraph.content).toHaveLength(3);

      expect(paragraph.content[0]).toEqual({ type: 'text', text: 'Visit ' });
      expect(paragraph.content[1]).toEqual({
        type: 'text',
        marks: [{
          type: 'link',
          attrs: {
            href: 'https://example.com',
            target: '_blank'
          }
        }],
        text: 'our site'
      });
      expect(paragraph.content[2]).toEqual({ type: 'text', text: ' today' });
    });

    it('should handle bold and links in the same line', () => {
      const result = textToTipTap('**Important:** See [docs](https://example.com) now');

      const paragraph = result.body.content[0];
      expect(paragraph.content[0]).toEqual({
        type: 'text',
        marks: [{ type: 'bold' }],
        text: 'Important:'
      });
      expect(paragraph.content[2]).toEqual({
        type: 'text',
        marks: [{
          type: 'link',
          attrs: {
            href: 'https://example.com',
            target: '_blank'
          }
        }],
        text: 'docs'
      });
    });

    it('should handle empty strings', () => {
      const result = textToTipTap('');

      expect(result).toEqual({
        body: {
          type: 'doc',
          content: []
        }
      });
    });

    it('should filter out whitespace-only paragraphs', () => {
      const result = textToTipTap('Para 1\n\n   \n\nPara 2');

      expect(result.body.content).toHaveLength(2);
    });
  });

  describe('warning1 - "The Introduction" (Week 1)', () => {
    it('should include member name and robot personality', () => {
      const result = warning1('John');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('John');
      expect(fullText).toContain('Beep boop');
      expect(fullText).toContain('🤖');
    });

    it('should be reminder 1 of 4 with 3 remaining', () => {
      const result = warning1('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('reminder 1 of 4');
      expect(fullText).toContain('3 more reminders');
    });

    it('should include self-deprecating humor', () => {
      const result = warning1('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('I timed it');
      expect(fullText).toContain('End transmission');
    });

    it('should include community guidelines link', () => {
      const result = warning1('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('https://www.716.social/coc');
    });

    it('should include admin help form link', () => {
      const result = warning1('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('https://forms.gle/y5itkP1Ax7TdiSQD6');
    });

    it('should include 716.social branding', () => {
      const result = warning1('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('716.social');
    });

    it('should mention profile photo', () => {
      const result = warning1('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('profile photo');
    });
  });

  describe('warning2 - "The Persistent One" (Week 2)', () => {
    it('should include member name and Round 2 opener', () => {
      const result = warning2('Jane');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('Jane');
      expect(fullText).toContain('Round 2');
    });

    it('should be reminder 2 of 4 with 2 remaining', () => {
      const result = warning2('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('Reminder 2 of 4');
      expect(fullText).toContain('2 left');
    });

    it('should include confident humor', () => {
      const result = warning2('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('very');
      expect(fullText).toContain('literally the only thing I do');
    });

    it('should include community guidelines and help links', () => {
      const result = warning2('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('https://www.716.social/coc');
      expect(fullText).toContain('https://forms.gle/y5itkP1Ax7TdiSQD6');
    });
  });

  describe('warning3 - "The Serious One" (Week 3)', () => {
    it('should include member name and serious tone', () => {
      const result = warning3('Bob');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('Bob');
      expect(fullText).toContain('getting real');
    });

    it('should be reminder 3 of 4', () => {
      const result = warning3('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('Reminder 3 of 4');
    });

    it('should include one small joke then serious', () => {
      const result = warning3('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('see');
      expect(fullText).toContain('Please add a photo now');
    });

    it('should include community guidelines and help links', () => {
      const result = warning3('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('https://www.716.social/coc');
      expect(fullText).toContain('https://forms.gle/y5itkP1Ax7TdiSQD6');
    });
  });

  describe('finalWarning - "The Goodbye" (Week 4)', () => {
    it('should include member name and urgency markers', () => {
      const result = finalWarning('Alice', 'next Monday');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('Alice');
      expect(fullText).toContain('🚨');
      expect(fullText).toContain('final warning');
    });

    it('should include next check date for deactivation timeline', () => {
      const result = finalWarning('Test', 'February 10th');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('February 10th');
      expect(fullText).toContain('deactivated');
    });

    it('should include minimal robot personality', () => {
      const result = finalWarning('Test', 'next week');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('One last beep boop');
      expect(fullText).toContain('🤖');
    });

    it('should include reactivation instructions', () => {
      const result = finalWarning('Test', 'next Monday');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('https://forms.gle/y5itkP1Ax7TdiSQD6');
      expect(fullText).toContain('back in');
    });

    it('should include community guidelines link', () => {
      const result = finalWarning('Test', 'next Monday');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('https://www.716.social/coc');
    });
  });

  describe('thankYouMessage - "The Celebration"', () => {
    it('should include member name and celebration', () => {
      const result = thankYouMessage('Emma');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('Emma');
      expect(fullText).toContain('🎉');
      expect(fullText).toContain('BEEP BOOP BEEP BOOP');
    });

    it('should include full robot personality return', () => {
      const result = thankYouMessage('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('thrilled');
      expect(fullText).toContain('Happy beep boop');
      expect(fullText).toContain('🤖');
    });

    it('should include community encouragement', () => {
      const result = thankYouMessage('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('716.social community');
      expect(fullText).toContain('face to the name');
    });

    it('should include humor about photo detection', () => {
      const result = thankYouMessage('Test');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('photo-detection algorithm');
      expect(fullText).toContain('👍👍');
    });
  });

  describe('Story Arc - Messages produce distinct output', () => {
    it('should produce unique messages for all 4 warning levels', () => {
      const messages = [
        JSON.stringify(warning1('Test')),
        JSON.stringify(warning2('Test')),
        JSON.stringify(warning3('Test')),
        JSON.stringify(finalWarning('Test', 'next Monday'))
      ];

      const unique = new Set(messages);
      expect(unique.size).toBe(4);
    });

    it('should have personality markers unique to each message', () => {
      const w1 = JSON.stringify(warning1('Test'));
      const w2 = JSON.stringify(warning2('Test'));
      const w3 = JSON.stringify(warning3('Test'));
      const w4 = JSON.stringify(finalWarning('Test', 'next Monday'));

      // Warning 1 unique markers
      expect(w1).toContain('Beep boop');
      expect(w1).toContain('End transmission');

      // Warning 2 unique markers
      expect(w2).toContain('Round 2');
      expect(w2).toContain('literally the only thing I do');

      // Warning 3 unique markers
      expect(w3).toContain('getting real');

      // Warning 4 unique markers
      expect(w4).toContain('One last beep boop');
    });
  });

  describe('adminAlert - Admin Notifications', () => {
    it('should generate admin alert for FINAL_WARNING action', () => {
      const result = adminAlert(
        'FINAL_WARNING',
        'John Doe',
        'john@example.com',
        4,
        'abc123',
        'Member has until next Monday to add a photo.'
      );

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('FINAL_WARNING');
      expect(fullText).toContain('John Doe');
      expect(fullText).toContain('john@example.com');
      expect(fullText).toContain('4');
      expect(fullText).toContain('abc123');
      expect(fullText).toContain('next Monday');
    });

    it('should generate admin alert for DEACTIVATION action', () => {
      const result = adminAlert(
        'DEACTIVATION',
        'Jane Smith',
        'jane@example.com',
        5,
        'def456',
        'Account deactivated after 5 warnings.'
      );

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('DEACTIVATION');
      expect(fullText).toContain('Jane Smith');
      expect(fullText).toContain('5');
    });

    it('should include profile URL', () => {
      const result = adminAlert('ERROR', 'Test', 'test@example.com', 3, 'xyz789', 'API error');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('https://www.716.social/u/xyz789');
    });

    it('should include timestamp', () => {
      const result = adminAlert('FINAL_WARNING', 'Test', 'test@example.com', 4, '123', '');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('Automated enforcement run');
      // Should contain ISO timestamp format
      expect(fullText).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    });

    it('should handle empty additional context', () => {
      const result = adminAlert('FINAL_WARNING', 'Test', 'test@example.com', 4, '123');

      expect(result.body.type).toBe('doc');
      expect(result.body.content).toBeInstanceOf(Array);
    });
  });

  describe('getWarningMessage - Convenience Function', () => {
    it('should return warning1 for level 1', () => {
      const result = getWarningMessage('John', 1);

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('John');
      expect(fullText).toContain('Beep boop');
      expect(fullText).toContain('reminder 1 of 4');
    });

    it('should return warning2 for level 2', () => {
      const result = getWarningMessage('Jane', 2);

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('Round 2');
      expect(fullText).toContain('Reminder 2 of 4');
    });

    it('should return warning3 for level 3', () => {
      const result = getWarningMessage('Bob', 3);

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('getting real');
      expect(fullText).toContain('Reminder 3 of 4');
    });

    it('should return final warning for level 4', () => {
      const result = getWarningMessage('Alice', 4, 'March 1st');

      const fullText = JSON.stringify(result);
      expect(fullText).toContain('final warning');
      expect(fullText).toContain('March 1st');
    });

    it('should throw error for level 5 (no deactivation DM)', () => {
      expect(() => getWarningMessage('Charlie', 5)).toThrow('Invalid warning level: 5');
    });

    it('should throw error for invalid warning levels', () => {
      expect(() => getWarningMessage('Test', 0)).toThrow('Invalid warning level: 0');
      expect(() => getWarningMessage('Test', 6)).toThrow('Invalid warning level: 6');
      expect(() => getWarningMessage('Test', -1)).toThrow('Invalid warning level');
    });

    it('should use default nextCheckDate for level 4', () => {
      const result = getWarningMessage('Test', 4);
      const fullText = JSON.stringify(result);
      expect(fullText).toContain('next Monday');
    });
  });

  describe('TipTap JSON Structure Validation', () => {
    it('should have valid root structure for all message types', () => {
      const messages = [
        warning1('Test'),
        warning2('Test'),
        warning3('Test'),
        finalWarning('Test', 'tomorrow'),
        thankYouMessage('Test'),
        adminAlert('FINAL_WARNING', 'Test', 'test@test.com', 4, '123', '')
      ];

      messages.forEach(message => {
        expect(message).toHaveProperty('body');
        expect(message.body).toHaveProperty('type', 'doc');
        expect(message.body).toHaveProperty('content');
        expect(message.body.content).toBeInstanceOf(Array);
      });
    });

    it('should have valid paragraph nodes', () => {
      const result = warning1('Test');

      result.body.content.forEach(node => {
        expect(node.type).toBe('paragraph');
        expect(node).toHaveProperty('content');
        expect(node.content).toBeInstanceOf(Array);
      });
    });

    it('should have valid text nodes within paragraphs', () => {
      const result = thankYouMessage('Test');

      result.body.content.forEach(paragraph => {
        paragraph.content.forEach(node => {
          expect(['text', 'hardBreak']).toContain(node.type);

          if (node.type === 'text') {
            expect(node).toHaveProperty('text');
            expect(typeof node.text).toBe('string');

            if (node.marks) {
              expect(node.marks).toBeInstanceOf(Array);
            }
          }
        });
      });
    });
  });
});
