import React from 'react';
import { WorktreeSectionContent } from '@/components/sections/openchamber/WorktreeSectionContent';
import { ProjectActionsSection } from '@/components/sections/projects/ProjectActionsSection';
import { ProjectIdentityFields } from '@/components/sections/projects/ProjectIdentityFields';
import { SharedProjectConfigSection } from '@/components/sections/projects/SharedProjectConfigSection';
import {
  useProjectIdentityForm,
  type ProjectIdentitySaveData,
} from '@/components/sections/projects/useProjectIdentityForm';
import { useProjectIdentityAutoSave } from '@/components/sections/projects/useProjectIdentityAutoSave';
import type { ProjectEntry } from '@/lib/api/types';

type ProjectSettingsPanelProps = {
  project: ProjectEntry | null;
  onIdentitySave: (data: ProjectIdentitySaveData) => void | Promise<void>;
  /**
   * The project-edit dialog hides the worktree section — worktrees have
   * their own full-page surface (project menu → Manage worktrees). Settings
   * keeps the full panel.
   */
  showWorktrees?: boolean;
};

export const ProjectSettingsPanel: React.FC<ProjectSettingsPanelProps> = ({
  project,
  onIdentitySave,
  showWorktrees = true,
}) => {
  const form = useProjectIdentityForm(project);

  const projectRef = React.useMemo(() => {
    if (!project) {
      return null;
    }
    return { id: project.id, path: project.path };
  }, [project]);

  const handleIdentitySave = React.useCallback(async (data: ProjectIdentitySaveData) => {
    await onIdentitySave(data);
  }, [onIdentitySave]);

  useProjectIdentityAutoSave(form, handleIdentitySave);

  if (!project || !projectRef) {
    return null;
  }

  return (
    <div className="space-y-0">
      <ProjectIdentityFields form={form} />
      <ProjectActionsSection projectRef={projectRef} />
      {showWorktrees ? <WorktreeSectionContent projectRef={projectRef} /> : null}
      {/* --- GeoCode: this block is the team's shared file and nothing else — where it is,
          whether it parsed, and the shared plans folder. The server reports it missing and
          refuses the write (lib/projects/routes.js), so all it could show here is a file that
          never appears and a folder setting that never saves. ---
      <SharedProjectConfigSection projectRef={projectRef} />
      --- /GeoCode --- */}
    </div>
  );
};
