import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { title?: string };

function Icon({ children, title, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} {...props}>
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const GridIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Icon>;
export const ChatIcon = (props: IconProps) => <Icon {...props}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-5 4v-4.5A2.5 2.5 0 0 1 2 13V5.5Z"/></Icon>;
export const SettingsIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.16.38.4.72.7 1 .3.26.68.4 1.1.4h.1v4h-.1a1.7 1.7 0 0 0-1.8.6Z"/></Icon>;
export const SearchIcon = (props: IconProps) => <Icon {...props}><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></Icon>;
export const PlusIcon = (props: IconProps) => <Icon {...props}><path d="M12 5v14M5 12h14"/></Icon>;
export const RefreshIcon = (props: IconProps) => <Icon {...props}><path d="M4 8c2.7-5.2 10.6-6.2 16 0M20 16c-2.7 5.2-10.6 6.2-16 0"/><path d="m16.5 4.5 3.5 3.5-3.5 3.5M7.5 12.5 4 16l3.5 3.5"/></Icon>;
export const CompactionIcon = (props: IconProps) => <Icon {...props}><path d="M4 6h16M7 12h10M9 18h6"/><path d="m4 9 3 3-3 3M20 9l-3 3 3 3"/></Icon>;
export const ChevronDownIcon = (props: IconProps) => <Icon {...props}><path d="m6 9 6 6 6-6"/></Icon>;
export const ChevronRightIcon = (props: IconProps) => <Icon {...props}><path d="m9 6 6 6-6 6"/></Icon>;
export const ArrowLeftIcon = (props: IconProps) => <Icon {...props}><path d="m15 18-6-6 6-6"/></Icon>;
export const TerminalIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></Icon>;
export const ToolIcon = (props: IconProps) => <Icon {...props}><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5L20 16.4a2.5 2.5 0 1 1-3.6 3.6l-7.7-7.7"/></Icon>;
export const FileIcon = (props: IconProps) => <Icon {...props}><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/></Icon>;
export const AgentIcon = (props: IconProps) => <Icon {...props}><circle cx="8" cy="9" r="3"/><circle cx="17" cy="8" r="2.5"/><path d="M2.5 20a5.5 5.5 0 0 1 11 0M13 20a4 4 0 0 1 8 0"/></Icon>;
export const SubagentsIcon = (props: IconProps) => <Icon {...props}>
  <g transform="translate(0 -1.7)"><g className="subagents-icon-back" fill="currentColor" stroke="none" opacity=".46"><circle cx="16" cy="7.5" r="3"/><path d="M11.6 18.5c.3-4.2 1.8-6.3 4.4-6.3s4.1 2.1 4.4 6.3Z"/></g><g className="subagents-icon-front" fill="currentColor" stroke="none"><circle cx="8.4" cy="9.3" r="3.4"/><path d="M2.6 21c.4-4.8 2.3-7.2 5.8-7.2s5.4 2.4 5.8 7.2Z"/></g></g>
</Icon>;
export const ShieldIcon = (props: IconProps) => <Icon {...props}><path d="M12 2 20 5v6c0 5-3.4 9.2-8 11-4.6-1.8-8-6-8-11V5z"/><path d="m9 12 2 2 4-5"/></Icon>;
export const QuestionIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 1 1 3.3 2.4c-.9.4-.9 1.1-.9 2M12 17h.01"/></Icon>;
export const InfoIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 7h.01"/></Icon>;
export const AlertIcon = (props: IconProps) => <Icon {...props}><path d="M12 3 2 21h20z"/><path d="M12 9v5M12 18h.01"/></Icon>;
export const CheckIcon = (props: IconProps) => <Icon {...props}><path d="m5 12 4 4L19 6"/></Icon>;
export const StopIcon = (props: IconProps) => <Icon {...props}><rect x="6" y="6" width="12" height="12" rx="1"/></Icon>;
export const SendIcon = (props: IconProps) => <Icon {...props}><path d="m3 3 18 9-18 9 4-9zM7 12h14"/></Icon>;
export const PaperclipIcon = (props: IconProps) => <Icon {...props}><path d="m20.5 11.5-8.8 8.8a6 6 0 0 1-8.5-8.5L13 2a4 4 0 0 1 5.7 5.7l-9.9 9.9a2 2 0 1 1-2.8-2.8l9.2-9.2"/></Icon>;
export const FolderIcon = (props: IconProps) => <Icon {...props}><path d="M3 6h7l2 2h9v11H3z"/></Icon>;
export const FolderPlusIcon = (props: IconProps) => <Icon {...props}><path d="M3 7h7l2 2h8v10H3z"/><path d="M18 2.5v7M14.5 6h7"/></Icon>;
export const ClockIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></Icon>;
export const ExplorerIcon = (props: IconProps) => <Icon {...props}><path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2M7 13h10M12 10l-3 3 3 3"/></Icon>;
export const VSCodeIcon = (props: IconProps) => <Icon {...props}><path d="m16 3 5 2.3v13.4L16 21 7.5 13.5 4 16l-2-2 5.5-5.5L16 3Z"/><path d="M16 3v18M7.5 8.5 16 15"/></Icon>;
export const CursorAppIcon = (props: IconProps) => <Icon {...props}><path d="M5 3.5 20 12 5 20.5Z"/><path d="m5 3.5 7 12.7L20 12"/></Icon>;
export const WindsurfIcon = (props: IconProps) => <Icon {...props}><path d="M3 8c3.2 0 3.2-3 6.4-3s3.2 3 6.4 3S19 5 22 5M2 13c3.2 0 3.2-3 6.4-3s3.2 3 6.4 3S18 10 21 10M3 18c3.2 0 3.2-3 6.4-3s3.2 3 6.4 3S19 15 22 15"/></Icon>;
export const SublimeIcon = (props: IconProps) => <Icon {...props}><path d="m4 7 16-4v6L4 13Zm0 8 16-4v6L4 21Z"/></Icon>;
export const NotepadPlusIcon = (props: IconProps) => <Icon {...props}><rect x="4" y="3" width="13" height="18" rx="2"/><path d="M8 8h5M8 12h5M8 16h5M20 9v7M16.5 12.5h7"/></Icon>;
export const ZedIcon = (props: IconProps) => <Icon {...props}><path d="M4 5h16L7 19h13M8 9h8M8 15h8"/></Icon>;
export const CommandIcon = (props: IconProps) => <Icon {...props}><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/></Icon>;
export const SlashCommandIcon = (props: IconProps) => <Icon {...props}><path d="m15.5 4.5-7 15"/></Icon>;
export const SlidersIcon = (props: IconProps) => <Icon {...props}><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="18" r="2"/></Icon>;
export const XIcon = (props: IconProps) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18"/></Icon>;
export const MoreIcon = (props: IconProps) => <Icon {...props}><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></Icon>;
export const CopyIcon = (props: IconProps) => <Icon {...props}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></Icon>;
export const AnnotationIcon = (props: IconProps) => <Icon {...props}><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8M8 13h5"/></Icon>;
export const EditIcon = (props: IconProps) => <Icon {...props}><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></Icon>;
export const EyeIcon = (props: IconProps) => <Icon {...props}><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></Icon>;
export const BrowserIcon = (props: IconProps) => <Icon {...props}><rect x="2.5" y="3" width="19" height="18" rx="2.5"/><path d="M2.5 8h19M6 5.5h.01M9 5.5h.01"/></Icon>;
export const GlobeIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.3 2.4 3.5 5.4 3.5 9S14.3 18.6 12 21M12 3c-2.3 2.4-3.5 5.4-3.5 9s1.2 6.6 3.5 9"/></Icon>;
export const HomeIcon = (props: IconProps) => <Icon {...props}><path d="m3 11 9-8 9 8M5.5 9.5V21h13V9.5M9.5 21v-6h5v6"/></Icon>;
export const LockIcon = (props: IconProps) => <Icon {...props}><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></Icon>;
export const DownloadIcon = (props: IconProps) => <Icon {...props}><path d="M12 3v12m-5-5 5 5 5-5M4 21h16"/></Icon>;
export const VolumeIcon = (props: IconProps) => <Icon {...props}><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></Icon>;
export const MutedIcon = (props: IconProps) => <Icon {...props}><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m16 9 5 6M21 9l-5 6"/></Icon>;
export const TrashIcon = (props: IconProps) => <Icon {...props}><path d="M4 7h16M9 3h6l1 4H8l1-4ZM6 7l1 14h10l1-14M10 11v6M14 11v6"/></Icon>;
export const RecordIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="7"/></Icon>;
export const WorkflowIcon = (props: IconProps) => <Icon {...props}><circle cx="6" cy="5" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="6" cy="19" r="2"/><path d="M8 5h2a3 3 0 0 1 3 3v1a3 3 0 0 0 3 3M8 19h2a3 3 0 0 0 3-3v-1a3 3 0 0 1 3-3"/></Icon>;
export const MouseIcon = (props: IconProps) => <Icon {...props}><rect x="6" y="2" width="12" height="20" rx="6"/><path d="M12 2v7M6 10h12"/></Icon>;
export const KeyboardIcon = (props: IconProps) => <Icon {...props}><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M6 14h.01M9 14h.01M12 14h6M6 17h10"/></Icon>;
export const ScreenshotIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="m7 5 1.5-2h7L17 5"/></Icon>;
export const MicrophoneIcon = (props: IconProps) => <Icon {...props}><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></Icon>;
export const WalletIcon = (props: IconProps) => <Icon {...props}><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H19v16H6.5A2.5 2.5 0 0 1 4 17.5z"/><path d="M4 7h15M15 11h6v5h-6a2.5 2.5 0 0 1 0-5Z"/><circle cx="16.5" cy="13.5" r=".5"/></Icon>;
export const PinIcon = (props: IconProps) => <Icon {...props}><path d="M9 3h6l-1 6 4 3.5V15H6v-2.5L10 9z"/><path d="M12 15v6"/></Icon>;
export const GoalIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3"/></Icon>;
export const RenameIcon = (props: IconProps) => <Icon {...props}><path d="M4 20h5l10.5-10.5a2.5 2.5 0 0 0-3.5-3.5L5.5 16.5z"/><path d="m14.5 6.5 3.5 3.5"/></Icon>;
export const ArchiveIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="4" width="18" height="4.5" rx="1"/><path d="M5 8.5V20h14V8.5M10 13h4"/></Icon>;
export const BranchIcon = (props: IconProps) => <Icon {...props}><circle cx="6" cy="5" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v6a6 6 0 0 0 6 6h4M8 8h4a6 6 0 0 1 6 6v3"/></Icon>;
/** One local wire dividing into two phone-facing paths: Tethoq's Bridge action. */
export const BridgeIcon = (props: IconProps) => <Icon {...props}><path d="M3 12h5c3 0 3.5-6 7-6h6M8 12c3 0 3.5 6 7 6h6"/><path d="M19 4v4M19 16v4"/></Icon>;
export const ExternalLinkIcon = (props: IconProps) => <Icon {...props}><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></Icon>;
export const ContextHandoffIcon = (props: IconProps) => <Icon {...props}><rect x="2.5" y="3.5" width="13" height="10" rx="2.5"/><path d="M5.5 7h7M5.5 10h4.5M15.5 9.5h3.5a2 2 0 0 1 2 2V18l-3.2-2.4a1.5 1.5 0 0 0-.9-.3h-4.4a2 2 0 0 1-2-2v-1.8"/><path d="m17.5 15.5 1.2 1.2 2-2"/></Icon>;
export const LogoMark = (props: IconProps) => <Icon {...props}><path d="M5 4h5v5H5zM14 4h5v5H5zM5 15h5v5H5zM14 15h5v5h-5z"/><path d="M10 6.5h4M7.5 9v6M16.5 9v6M10 17.5h4"/></Icon>;
