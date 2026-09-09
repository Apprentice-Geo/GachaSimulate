export type UserRequestKind =
  | "simulation"
  | "analysis"
  | "result-save"
  | "config-refresh"
  | "config-change";

export class UserRequestAdmission {
  private export_owner: string | null = null;
  private shutting_down = false;

  admit(kind: UserRequestKind): void {
    void kind;
    if (this.shutting_down) throw new Error("application is shutting down");
    if (this.export_owner)
      throw new Error("a new task cannot start during export");
  }

  reserve_export(reservation_id: string): void {
    if (this.shutting_down) throw new Error("application is shutting down");
    if (this.export_owner) throw new Error("an export is already active");
    this.export_owner = reservation_id;
  }

  handoff_export(reservation_id: string, task_id: string): void {
    if (this.export_owner !== reservation_id)
      throw new Error("export reservation is no longer active");
    this.export_owner = task_id;
  }

  release_export(owner_id: string): void {
    if (this.export_owner === owner_id) this.export_owner = null;
  }

  begin_shutdown(): void {
    this.shutting_down = true;
  }

  get export_active(): boolean {
    return this.export_owner !== null;
  }
}
