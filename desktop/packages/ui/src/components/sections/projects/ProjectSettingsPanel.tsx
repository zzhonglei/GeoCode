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
import { PROJECT_ACTIONS_OFFERED } from '@/geocode/advanced-project-surface'; // GeoCode: own module
import { REPOSITORY_SHARING_OFFERED } from '@/geocode/repository-sharing-surface'; // GeoCode: own module

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
      {/* --- GeoCode: a sidebar button bound to a shell command is not a GeoCode surface
          (geocode/advanced-project-surface.ts) --- */}
      {!PROJECT_ACTIONS_OFFERED ? null : <ProjectActionsSection projectRef={projectRef} />}
      {/* GeoCode: upstream's own list-only mode, which drops the worktree setup commands and keeps the list */}
      {showWorktrees ? <WorktreeSectionContent projectRef={projectRef} sections="list-only" /> : null}
      {/* --- GeoCode: the server reports the team's shared file missing and refuses its writes
          (geocode/repository-sharing-surface.ts) --- */}
      {!REPOSITORY_SHARING_OFFERED ? null : <SharedProjectConfigSection projectRef={projectRef} />}
    </div>
  );
};
