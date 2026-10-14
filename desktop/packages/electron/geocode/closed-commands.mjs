// Commands for other hosts, SSH, dev-server tunnels, isolated spaces, LAN addresses and OpenChamber updates.
const CLOSED_COMMANDS = new Set([
  'desktop_hosts_set',
  'desktop_host_probe',
  'desktop_host_update_server',
  'desktop_remote_password_login',
  'desktop_new_window_for_host',
  'desktop_new_window_at_url',
  'desktop_dev_tunnel_open',
  'desktop_dev_tunnel_close',
  'desktop_relay_dev_tunnel_close_all',
  'desktop_space_preview_prepare',
  'desktop_get_lan_address',
  'desktop_check_for_updates',
  'desktop_download_and_install_update',
  'desktop_ssh_instances_get',
  'desktop_ssh_instances_set',
  'desktop_ssh_import_hosts',
  'desktop_ssh_connect',
  'desktop_ssh_disconnect',
  'desktop_ssh_status',
  'desktop_ssh_logs',
  'desktop_ssh_logs_clear',
]);

export const assertDesktopCommandOpen = (command) => {
  if (CLOSED_COMMANDS.has(command)) {
    throw new Error(`${command} is not available in this app`);
  }
};
