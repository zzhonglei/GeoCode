/* --- GeoCode: /schedule-task tells the user an unattended run waits at the steps that ask for approval, and names
 * the switch that lifts it the way the task editor shows it (docs/DESKTOP.md §7.3). --- */
import { describe, expect, test } from 'bun:test';

import { dict as en } from '../lib/i18n/messages/en';
import { getDefaultMagicPromptTemplate } from '../lib/magicPrompts';

describe('the scheduled task prompt', () => {
  test('names the auto-accept switch by the label the task editor shows', () => {
    // GeoAgent asks before running QGIS algorithms and Earth Engine scripts, so a run nobody watches stops there,
    // and a name the editor does not show sends the user looking for a switch that is not there.
    expect(getDefaultMagicPromptTemplate('session.scheduleTask.instructions'))
      .toContain(en['sessions.scheduledTasks.editor.permissionAutoAccept.label']);
  });
});
