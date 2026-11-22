import React, { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Bookmark,
  Camera,
  Check,
  CheckCheck,
  Clock,
  Loader2,
  MapPin,
  MessageSquarePlus,
  Pencil,
  Pin,
  Search,
  Send,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { CampusLocation, Conversation, Message } from '../types';
import { LazyLeafletMap } from '../components/map/LazyLeafletMap';
import {
  compressMultipleImages,
  IMAGE_UPLOAD_ACCEPT,
  IMAGE_UPLOAD_GUIDANCE,
  MAX_ATTACHMENTS_POST,
} from '../utils/imageCompression';
import { ChatThreadSkeleton } from '../components/common/Skeletons';
import { useDebounce } from '../utils/useDebounce';
import { getThumbnailUrl, resolveMediaUrl } from '../utils/mediaUrl';
import { useSavedLocations } from '../utils/useSavedLocations';
import { api } from '../api/client';
import { GlassButton, GlassCard, GlassTab } from '../components/glass';
import { MentionText } from '../components/common/MentionText';
import { UserAvatar } from '../components/common/UserAvatar';
import {
  MentionInput,
  MentionSuggestionsDropdown,
  useMentionAutocomplete,
} from '../components/common/MentionInput';
import { triggerHaptic } from '../utils/haptics';

const LocationPickerModal = lazy(() =>
  import('../components/map/LocationPickerModal').then((m) => ({ default: m.LocationPickerModal }))
);
const LocationViewModal = lazy(() =>
  import('../components/map/LocationViewModal').then((m) => ({ default: m.LocationViewModal }))
);
const ImageViewerModal = lazy(() =>
  import('../components/common/ImageViewerModal').then((m) => ({ default: m.ImageViewerModal }))
);
const NewChatModal = lazy(() =>
  import('../components/chat/NewChatModal').then((m) => ({ default: m.NewChatModal }))
);

interface ChatsPageProps {
  conversations: Conversation[];
  selectedConvId?: string | null;
  onSelectConv?: (id: string | null) => void;
  mobileShowThread?: boolean;
  onMobileShowThreadChange?: (show: boolean) => void;
  onSendMessage: (
    conversationId: string,
    text: string,
    location?: CampusLocation,
    images?: string[],
    clientId?: string
  ) => void;
  onEditMessage?: (conversationId: string, messageId: string, text: string) => Promise<boolean> | void;
  onDeleteMessage?: (conversationId: string, messageId: string) => Promise<boolean> | void;
  onMarkChatRead?: (conversationId: string) => Promise<void> | void;
  onViewUserProfile?: (userId: string) => void;
  onRefreshChats?: () => void;
  isLoading?: boolean;
}

const getConversationKind = (conv: Conversation): 'direct' | 'group' => {
  if (conv.type === 'group' || conv.type === 'direct') return conv.type;
  const sub = (conv.subtitle || '').toLowerCase();
  if (sub.includes('group') || sub.includes('guild') || sub.includes('lounge') || sub.includes('society')) {
    return 'group';
  }
  return 'direct';
};

interface ConversationRowProps {
  conv: Conversation;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

const ConversationRow: React.FC<ConversationRowProps> = memo(({ conv, isSelected, onSelect }) => {
  const isDirect = getConversationKind(conv) === 'direct';
  const lastMsg = conv.messages[conv.messages.length - 1];
  const showDirectReceipt = isDirect && Boolean(lastMsg?.isMe);

  return (
    <button
      onClick={() => onSelect(conv.id)}
      className={`w-full px-4 py-3.5 flex items-center gap-3 transition-colors text-left cursor-pointer ${
        isSelected
          ? 'bg-[#F6E2E6]/55 dark:bg-[#D98BA5]/20'
          : 'hover:bg-[#FFFCF7]/75 dark:hover:bg-[#23211C]/70'
      }`}
    >
      <div className="relative shrink-0">
        <UserAvatar
          name={conv.title}
          initials={conv.avatarInitials}
          avatarUrl={conv.avatarUrl}
          avatarThumbUrl={conv.avatarThumbUrl}
          size="md"
          className="w-11 h-11 shadow-sm"
        />
        {conv.isOnline && (
          <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-[#D98BA5] ring-2 ring-[#FFFCF7] dark:ring-[#181714]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold text-[#171613] dark:text-[#F5EFE3] truncate">{conv.title}</span>
          <span className="text-[10px] font-mono tabular-nums text-[#82796F] dark:text-[#A89F95] shrink-0">{conv.timestamp}</span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="flex items-center gap-1 min-w-0 text-[11px] text-[#82796F] dark:text-[#A89F95]">
            {showDirectReceipt && (
              lastMsg?.status === 'read' ? (
                <CheckCheck className="w-3.5 h-3.5 text-[#C4718E] dark:text-[#E5A4BA] shrink-0" aria-label="Read" />
              ) : (
                <Check className="w-3.5 h-3.5 text-[#82796F] dark:text-[#A89F95] shrink-0" aria-label="Sent" />
              )
            )}
            <span className="truncate">{conv.lastMessage || conv.subtitle || 'No messages yet'}</span>
          </span>
          {conv.unreadCount > 0 && (
            <span className="min-w-[20px] h-5 px-1.5 rounded-md glass-pink text-[#171613] text-[10px] font-mono font-bold flex items-center justify-center tabular-nums shrink-0">
              {conv.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
});

ConversationRow.displayName = 'ConversationRow';

interface MessageBubbleProps {
  msg: Message;
  chatId: string;
  isDirectChat: boolean;
  isEditing: boolean;
  editDraft: string;
  isSavingEdit: boolean;
  isDeleting: boolean;
  onStartEdit: (msg: Message) => void;
  onChangeEditDraft: (val: string) => void;
  onSaveEdit: (msgId: string) => void;
  onCancelEdit: () => void;
  onDelete: (msgId: string) => void;
  onRetry: (msg: Message) => void;
  onOpenLocation: (loc: CampusLocation, withDirections?: boolean) => void;
  onOpenLightbox: (images: string[], index: number, title: string) => void;
  onViewUserProfile?: (userId: string) => void;
}

const MessageBubble: React.FC<MessageBubbleProps> = memo(
  ({
    msg,
    chatId,
    isDirectChat,
    isEditing,
    editDraft,
    isSavingEdit,
    isDeleting,
    onStartEdit,
    onChangeEditDraft,
    onSaveEdit,
    onCancelEdit,
    onDelete,
    onRetry,
    onOpenLocation,
    onOpenLightbox,
    onViewUserProfile,
  }) => {
    const [confirmDelete, setConfirmDelete] = useState(false);
    const canModify = Boolean(
      msg.isMe && (msg.status === 'sent' || msg.status === 'read') && !msg.id.startsWith('cli-')
    );

    return (
      <div
        className={`flex flex-col max-w-[85%] sm:max-w-[75%] group ${
          msg.isMe ? 'self-end items-end' : 'self-start items-start'
        }`}
      >
        {!msg.isMe && (
          <button
            type="button"
            disabled={isDirectChat || !msg.senderId || !onViewUserProfile}
            onClick={() => !isDirectChat && msg.senderId && onViewUserProfile?.(msg.senderId)}
            className={`inline-flex items-center gap-1.5 text-[11px] font-medium text-[#82796F] dark:text-[#A89F95] mb-1 px-0.5 ${
              !isDirectChat && msg.senderId && onViewUserProfile
                ? 'hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer'
                : 'cursor-default'
            }`}
          >
            {!isDirectChat && (
              <UserAvatar
                name={msg.senderName}
                initials={msg.senderAvatarInitials}
                bg={msg.senderAvatarBg}
                avatarUrl={msg.senderAvatarUrl}
                avatarThumbUrl={msg.senderAvatarThumbUrl}
                size="xs"
                className="w-5 h-5 text-[9px]"
              />
            )}
            <span>{msg.senderName}</span>
          </button>
        )}

        <div
          className={`px-3.5 py-2.5 rounded-2xl text-xs md:text-sm leading-relaxed flex flex-col gap-2 ${
            msg.isMe
              ? 'bg-[#171613] dark:bg-[#2A2622] text-[#F5EFE3] rounded-br-sm shadow-sm border border-transparent dark:border-[#D98BA5]/25'
              : 'glass-strong text-[#171613] dark:text-[#F5EFE3] rounded-bl-sm'
          } ${msg.status === 'failed' ? 'ring-2 ring-[#D98BA5]' : ''}`}
        >
          {isEditing ? (
            <div className="flex flex-col gap-2 min-w-[210px] sm:min-w-[260px]">
              <MentionInput
                as="input"
                value={editDraft}
                onChange={onChangeEditDraft}
                chatId={chatId}
                placement="above"
                disabled={isSavingEdit}
                autoFocus
                placeholder="Edit message..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (editDraft.trim()) onSaveEdit(msg.id);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    onCancelEdit();
                  }
                }}
                className="w-full px-2.5 py-1.5 rounded-lg bg-[#FFFCF7] dark:bg-[#181714] text-[#171613] dark:text-[#F5EFE3] text-xs border border-[#D98BA5] focus:outline-none"
              />
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={onCancelEdit}
                  disabled={isSavingEdit}
                  className="px-2 py-1 rounded-lg text-[11px] text-[#E8DDCC] hover:text-[#FFFCF7] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => onSaveEdit(msg.id)}
                  disabled={isSavingEdit || !editDraft.trim()}
                  className="px-2.5 py-1 rounded-lg bg-[#D98BA5] text-[#171613] text-[11px] font-semibold inline-flex items-center gap-1 disabled:opacity-50 cursor-pointer"
                >
                  {isSavingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  <span>Save</span>
                </button>
              </div>
            </div>
          ) : (
            msg.text && (
              <div className="break-words whitespace-pre-wrap">
                <MentionText
                  text={msg.text}
                  mentions={msg.mentions}
                  bubbleTone={msg.isMe ? 'dark' : 'default'}
                  onMentionClick={onViewUserProfile}
                />
              </div>
            )
          )}

          {msg.images && msg.images.length > 0 && (
            <div className="flex flex-col gap-1.5 mt-1">
              {msg.images.map((imgUrl, imgIdx) => (
                <div
                  key={imgIdx}
                  onClick={() =>
                    onOpenLightbox(msg.images!, imgIdx, `${msg.senderName}'s shared photo`)
                  }
                  className="relative rounded-xl overflow-hidden max-w-[280px] sm:max-w-[320px] max-h-64 cursor-pointer group"
                >
                  <img
                    src={getThumbnailUrl(imgUrl)}
                    alt="Chat attachment"
                    className="w-full h-auto object-cover max-h-60 transition-transform duration-200 group-hover:scale-[1.02]"
                    loading="lazy"
                    decoding="async"
                    onError={(e) => {
                      const img = e.currentTarget;
                      if (!img.dataset.fallbackApplied) {
                        img.dataset.fallbackApplied = '1';
                        img.src = resolveMediaUrl(imgUrl);
                      }
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {msg.location && (
            <div
              onClick={() => onOpenLocation(msg.location!, false)}
              className={`rounded-xl overflow-hidden border p-2 flex flex-col gap-2 cursor-pointer ${
                msg.isMe
                  ? 'bg-[#FFFCF7]/10 border-[#FFFCF7]/15 text-[#F5EFE3]'
                  : 'bg-[#F5EFE3]/80 dark:bg-[#23211C] border-[#171613]/12 dark:border-[#F5EFE3]/15 text-[#171613] dark:text-[#F5EFE3]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <MapPin className="w-3.5 h-3.5 text-[#D98BA5] shrink-0" />
                  <span className="font-semibold text-xs truncate">{msg.location.name}</span>
                </div>
              </div>

              <div className="w-full h-24 rounded-lg overflow-hidden pointer-events-none border border-[#171613]/10 dark:border-[#F5EFE3]/12">
                <LazyLeafletMap
                  center={msg.location.coordinates}
                  zoom={16}
                  selectedCoordinates={msg.location.coordinates}
                  selectedLabel={msg.location.name}
                  height="96px"
                />
              </div>

              <div className="flex items-center justify-between text-[11px] pt-1">
                <span className="text-[10px] opacity-75">
                  {msg.location.isOffCampus ? 'Off-Campus' : 'Campus Spot'}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenLocation(msg.location!, true);
                  }}
                  className="px-2.5 py-0.5 rounded-lg text-[11px] font-semibold bg-[#D98BA5] text-[#171613] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Directions
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-[10px] font-mono tabular-nums text-[#82796F] dark:text-[#A89F95] mt-0.5 px-1">
          <span>
            {msg.timestamp}
            {msg.isEdited ? ' · edited' : ''}
          </span>
          {msg.isMe && (
            <>
              {msg.status === 'sending' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
              {msg.status === 'read' && isDirectChat && (
                <span
                  className="inline-flex items-center gap-0.5 text-[#C4718E] dark:text-[#E5A4BA] font-semibold"
                  title={msg.readAt ? `Read (${msg.readAt})` : 'Read'}
                  aria-label="Read"
                >
                  <CheckCheck className="w-3 h-3" />
                  <span>Read</span>
                </span>
              )}
              {msg.status === 'sent' && (
                isDirectChat ? (
                  <span
                    className="inline-flex items-center gap-0.5 text-[#82796F] dark:text-[#A89F95]"
                    aria-label="Sent"
                  >
                    <Check className="w-3 h-3" />
                    <span>Sent</span>
                  </span>
                ) : (
                  <span className="text-[#C4718E] dark:text-[#E5A4BA]">✓</span>
                )
              )}
              {msg.status === 'failed' && (
                <button
                  onClick={() => onRetry(msg)}
                  className="flex items-center gap-1 text-[#C4718E] dark:text-[#E5A4BA] hover:underline cursor-pointer font-bold"
                >
                  <AlertCircle className="w-2.5 h-2.5" />
                  <span>Retry</span>
                </button>
              )}
            </>
          )}

          {canModify && !isEditing && (
            <div className="flex items-center gap-1 opacity-80 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
              {msg.text && onStartEdit && (
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    onStartEdit(msg);
                  }}
                  aria-label="Edit message"
                  title="Edit message"
                  className="p-1 rounded hover:bg-[#E8DDCC]/70 dark:hover:bg-[#23211C] hover:text-[#171613] dark:hover:text-[#F5EFE3] cursor-pointer"
                >
                  <Pencil className="w-2.5 h-2.5" />
                </button>
              )}
              {confirmDelete ? (
                <div className="inline-flex items-center gap-1 font-sans">
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={() => onDelete(msg.id)}
                    className="px-1.5 py-0.5 rounded bg-[#C4718E] text-[#FFFCF7] text-[10px] font-semibold cursor-pointer"
                  >
                    {isDeleting ? '...' : 'Delete'}
                  </button>
                  <button
                    type="button"
                    disabled={isDeleting}
                    onClick={() => setConfirmDelete(false)}
                    className="px-1.5 py-0.5 rounded bg-[#E8DDCC]/70 dark:bg-[#23211C] text-[10px] cursor-pointer"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    setConfirmDelete(true);
                  }}
                  aria-label="Delete message"
                  title="Delete message"
                  className="p-1 rounded hover:bg-[#F6E2E6] dark:hover:bg-[#D98BA5]/20 hover:text-[#C4718E] cursor-pointer"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
);

MessageBubble.displayName = 'MessageBubble';

export const ChatsPage: React.FC<ChatsPageProps> = ({
  conversations,
  selectedConvId,
  onSelectConv,
  mobileShowThread: controlledMobileShowThread,
  onMobileShowThreadChange,
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  onMarkChatRead,
  onViewUserProfile,
  onRefreshChats,
  isLoading = false,
}) => {
  const [localConvId, setLocalConvId] = useState<string>(conversations[0]?.id || '');
  const activeConvId = selectedConvId ?? (localConvId || conversations[0]?.id || '');

  const [chatFilter, setChatFilter] = useState<'all' | 'direct' | 'group'>('all');
  const [chatSearch, setChatSearch] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [localMobileShowThread, setLocalMobileShowThread] = useState(false);
  const mobileShowThread = controlledMobileShowThread ?? localMobileShowThread;

  const setActiveConvId = useCallback(
    (id: string) => {
      if (selectedConvId === undefined) setLocalConvId(id);
      onSelectConv?.(id);
    },
    [onSelectConv, selectedConvId]
  );

  const setMobileShowThread = useCallback(
    (show: boolean) => {
      if (controlledMobileShowThread === undefined) setLocalMobileShowThread(show);
      onMobileShowThreadChange?.(show);
    },
    [controlledMobileShowThread, onMobileShowThreadChange]
  );

  const [attachedLocation, setAttachedLocation] = useState<CampusLocation | null>(null);
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatusLabel, setUploadStatusLabel] = useState('Optimizing photo...');
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageSuccess, setImageSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const [isNewChatModalOpen, setIsNewChatModalOpen] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [previewLocation, setPreviewLocation] = useState<CampusLocation | null>(null);
  const [openWithDirections, setOpenWithDirections] = useState(false);
  const [lightboxState, setLightboxState] = useState<{
    images: string[];
    index: number;
    title?: string;
  } | null>(null);
  const { savedLocations, pinLocation } = useSavedLocations();

  const debouncedChatSearch = useDebounce(chatSearch, 200);

  const { filteredConversations, directCount, groupCount } = useMemo(() => {
    let direct = 0;
    let group = 0;
    const q = debouncedChatSearch.trim().toLowerCase();
    const filtered: Conversation[] = [];

    for (const conv of conversations) {
      const kind = getConversationKind(conv);
      if (kind === 'direct') direct += 1;
      else group += 1;

      const matchesTab = chatFilter === 'all' || kind === chatFilter;
      const matchesSearch =
        !q ||
        conv.title.toLowerCase().includes(q) ||
        (conv.lastMessage || '').toLowerCase().includes(q) ||
        (conv.subtitle || '').toLowerCase().includes(q);
      if (matchesTab && matchesSearch) filtered.push(conv);
    }

    return { filteredConversations: filtered, directCount: direct, groupCount: group };
  }, [chatFilter, conversations, debouncedChatSearch]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConvId) || conversations[0],
    [activeConvId, conversations]
  );

  const composerMention = useMentionAutocomplete({
    value: messageInput,
    onChange: setMessageInput,
    chatId: activeConversation?.id,
    enabled: Boolean(activeConversation),
  });

  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true
  );
  const [isPageVisible, setIsPageVisible] = useState(() =>
    typeof document !== 'undefined' ? document.visibilityState !== 'hidden' : true
  );
  const lastMarkedReadRef = useRef<{ convId: string; lastIncomingId: string | null } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 768px)');
    const onMqChange = () => setIsDesktop(mq.matches);
    const onVisChange = () => setIsPageVisible(document.visibilityState !== 'hidden');
    mq.addEventListener?.('change', onMqChange);
    document.addEventListener('visibilitychange', onVisChange);
    window.addEventListener('focus', onVisChange);
    return () => {
      mq.removeEventListener?.('change', onMqChange);
      document.removeEventListener('visibilitychange', onVisChange);
      window.removeEventListener('focus', onVisChange);
    };
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages]);

  useEffect(() => {
    setEditingMessageId(null);
    setEditDraft('');
    composerMention.dismiss();
  }, [activeConvId]);

  const visibleConvId =
    (isDesktop || mobileShowThread) && activeConversation?.id ? activeConversation.id : '';

  useEffect(() => {
    if (!visibleConvId || !isPageVisible || !activeConversation) return;
    const incomingMsgs = activeConversation.messages.filter((m) => !m.isMe);
    const lastIncomingId = incomingMsgs.length > 0 ? incomingMsgs[incomingMsgs.length - 1].id : null;
    const prev = lastMarkedReadRef.current;

    const openedNewConv = prev?.convId !== visibleConvId;
    const receivedNewIncoming = Boolean(lastIncomingId && prev?.lastIncomingId !== lastIncomingId);
    const hasUnread = activeConversation.unreadCount > 0;

    if (openedNewConv || receivedNewIncoming || hasUnread) {
      lastMarkedReadRef.current = { convId: visibleConvId, lastIncomingId };
      if (onMarkChatRead) {
        onMarkChatRead(visibleConvId);
      } else {
        api.markChatAsRead(visibleConvId).catch(() => {});
      }
    }
  }, [visibleConvId, isPageVisible, activeConversation, onMarkChatRead]);

  const handleStartEditMessage = useCallback((msg: Message) => {
    setEditingMessageId(msg.id);
    setEditDraft(msg.text || '');
  }, []);

  const handleSaveEditMessage = useCallback(
    async (msgId: string) => {
      if (!activeConversation || !editDraft.trim() || !onEditMessage) return;
      setIsSavingEdit(true);
      try {
        const ok = await onEditMessage(activeConversation.id, msgId, editDraft.trim());
        if (ok !== false) {
          setEditingMessageId(null);
          setEditDraft('');
        }
      } finally {
        setIsSavingEdit(false);
      }
    },
    [activeConversation, editDraft, onEditMessage]
  );

  const handleDeleteMessageConfirm = useCallback(
    async (msgId: string) => {
      if (!activeConversation || !onDeleteMessage) return;
      setDeletingMessageId(msgId);
      try {
        await onDeleteMessage(activeConversation.id, msgId);
      } finally {
        setDeletingMessageId(null);
      }
    },
    [activeConversation, onDeleteMessage]
  );

  const handleOpenLocation = useCallback((loc: CampusLocation, withDirections = false) => {
    triggerHaptic('tap');
    setPreviewLocation(loc);
    setOpenWithDirections(withDirections);
  }, []);

  const handleOpenLightbox = useCallback((images: string[], index: number, title: string) => {
    triggerHaptic('tap');
    setLightboxState({ images, index, title });
  }, []);

  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const remaining = MAX_ATTACHMENTS_POST - attachedImages.length;
    if (remaining <= 0) {
      setImageError(`You can attach up to ${MAX_ATTACHMENTS_POST} photos per message.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setImageError(null);
    setImageSuccess(null);
    setIsUploadingImage(true);
    setUploadProgress(5);
    setUploadStatusLabel('Optimizing photo...');

    try {
      const { results, error } = await compressMultipleImages(files, remaining, (p) =>
        setUploadProgress(Math.max(5, Math.round(p * 0.5)))
      );
      if (error) {
        triggerHaptic('error');
        setImageError(error);
        setTimeout(() => setImageError(null), 6500);
        return;
      }

      const uploadedUrls: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const item = results[i];
        setUploadStatusLabel(
          results.length > 1 ? `Uploading photo ${i + 1} of ${results.length}...` : 'Uploading photo...'
        );
        const uploaded = await api.uploadImage(item.dataUrl, item.thumbnailDataUrl, (pct) => {
          const overall = Math.min(99, 50 + Math.round(((i + pct / 100) / Math.max(1, results.length)) * 50));
          setUploadProgress(overall);
        });
        uploadedUrls.push(uploaded.url);
      }

      if (uploadedUrls.length > 0) {
        setAttachedImages((prev) => [...prev, ...uploadedUrls].slice(0, MAX_ATTACHMENTS_POST));
        setImageSuccess(
          uploadedUrls.length === 1 ? 'Photo ready to send.' : `${uploadedUrls.length} photos ready to send.`
        );
        triggerHaptic('success');
        setTimeout(() => setImageSuccess(null), 3000);
      }
    } catch (err: unknown) {
      triggerHaptic('error');
      setImageError(err instanceof Error ? err.message : 'Failed to upload image.');
      setTimeout(() => setImageError(null), 6500);
    } finally {
      setIsUploadingImage(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const textToSend =
      messageInput.trim() ||
      (attachedLocation ? `📍 Shared spot: ${attachedLocation.name}` : attachedImages.length > 0 ? '📷 Photo' : '');
    if ((!textToSend && attachedImages.length === 0 && !attachedLocation) || !activeConversation) return;

    triggerHaptic('tap');
    const clientId = `cli-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    if (attachedLocation) {
      void pinLocation(attachedLocation, 'chat', { silent: true });
    }
    onSendMessage(
      activeConversation.id,
      textToSend,
      attachedLocation || undefined,
      attachedImages.length > 0 ? attachedImages : undefined,
      clientId
    );

    setMessageInput('');
    setAttachedLocation(null);
    setAttachedImages([]);
    setImageError(null);
    setImageSuccess(null);
  };

  const handleRetry = useCallback(
    (msg: Message) => {
      if (!activeConversation) return;
      triggerHaptic('tap');
      onSendMessage(activeConversation.id, msg.text, msg.location, msg.images, msg.clientId || msg.id);
    },
    [activeConversation, onSendMessage]
  );

  const handleSelectConv = useCallback((id: string) => {
    triggerHaptic('tap');
    setActiveConvId(id);
    setMobileShowThread(true);
  }, [setActiveConvId, setMobileShowThread]);

  const handleNewChatCreated = useCallback(
    (newChatId: string) => {
      setActiveConvId(newChatId);
      setMobileShowThread(true);
      onRefreshChats?.();
    },
    [onRefreshChats, setActiveConvId, setMobileShowThread]
  );

  return (
    <div className="w-full flex justify-center px-3 sm:px-4 py-3 md:py-6 min-h-[420px] h-[calc(100dvh-9.25rem)] md:h-[calc(100dvh-2rem)]">
      <GlassCard
        tone="cream"
        padding="none"
        className="w-full max-w-5xl rounded-2xl overflow-hidden flex flex-col md:flex-row h-full relative"
      >
        {/* Conversation List Pane */}
        <div
          className={`w-full md:w-80 lg:w-96 border-r border-[#171613]/10 dark:border-[#F5EFE3]/10 flex flex-col shrink-0 bg-[#FFFCF7]/45 dark:bg-[#161512]/70 relative h-full ${
            mobileShowThread ? 'hidden md:flex' : 'flex'
          }`}
        >
          <div className="p-4 pb-3 flex items-center justify-between gap-2">
            <div>
              <h1 className="font-serif text-2xl font-bold text-[#171613] dark:text-[#F5EFE3] leading-none">Chats</h1>
              <p className="text-[11px] text-[#82796F] dark:text-[#A89F95] mt-1">Study groups & direct messages</p>
            </div>
            <button
              type="button"
              onClick={() => {
                triggerHaptic('tap');
                setIsNewChatModalOpen(true);
              }}
              aria-label="Start new conversation"
              className="w-10 h-10 rounded-xl glass-subtle border border-[#171613]/10 dark:border-[#F5EFE3]/12 hover:bg-[#F6E2E6]/70 dark:hover:bg-[#D98BA5]/18 flex items-center justify-center text-[#171613] dark:text-[#F5EFE3] shrink-0 cursor-pointer transition-colors"
            >
              <MessageSquarePlus className="w-4 h-4" />
            </button>
          </div>

          <div className="px-4 pb-3 space-y-2.5 border-b border-[#171613]/8 dark:border-[#F5EFE3]/10">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#82796F] dark:text-[#A89F95] absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                placeholder="Search conversations..."
                className="w-full pl-9 pr-3.5 py-2.5 rounded-xl glass-input text-xs text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95]"
              />
            </div>

            <GlassTab
              variant="pink"
              items={[
                { id: 'all', label: 'All', count: conversations.length },
                { id: 'direct', label: 'Direct', count: directCount },
                { id: 'group', label: 'Groups', count: groupCount },
              ]}
              activeId={chatFilter}
              onChange={(id) => setChatFilter(id)}
            />
          </div>

          <div className="px-4 py-1.5 bg-[#E8DDCC]/40 dark:bg-[#23211C]/75 border-b border-[#171613]/8 dark:border-[#F5EFE3]/10 text-[10px] text-[#82796F] dark:text-[#A89F95] font-mono flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-[#C4718E] shrink-0" />
            <span>Messages expire automatically after 72h</span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-[#171613]/6 dark:divide-[#F5EFE3]/8">
            {isLoading && conversations.length === 0 ? (
              <ChatThreadSkeleton />
            ) : filteredConversations.length > 0 ? (
              filteredConversations.map((conv) => (
                <ConversationRow
                  key={conv.id}
                  conv={conv}
                  isSelected={conv.id === activeConvId}
                  onSelect={handleSelectConv}
                />
              ))
            ) : (
              <div className="p-8 text-center text-xs text-[#82796F] dark:text-[#A89F95]">
                No conversations match your current filter.
              </div>
            )}
          </div>
        </div>

        {/* Active Thread Pane */}
        <div
          className={`flex-1 flex flex-col h-full min-h-0 bg-[#F5EFE3]/45 dark:bg-[#0F0E0C]/55 ${
            !mobileShowThread ? 'hidden md:flex' : 'flex'
          }`}
        >
          {activeConversation ? (
            <>
              {/* Thread Top Header */}
              <div className="p-3.5 px-4 border-b border-[#171613]/10 dark:border-[#F5EFE3]/10 flex items-center justify-between bg-[#FFFCF7]/70 dark:bg-[#181714]/85 backdrop-blur-md">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    onClick={() => {
                      triggerHaptic('tap');
                      setMobileShowThread(false);
                    }}
                    aria-label="Back to conversations"
                    className="md:hidden w-10 h-10 rounded-xl bg-[#E8DDCC]/70 dark:bg-[#23211C] flex items-center justify-center text-[#171613] dark:text-[#F5EFE3] shrink-0 cursor-pointer"
                  >
                    <ArrowLeft className="w-5 h-5" />
                  </button>

                  <UserAvatar
                    name={activeConversation.title}
                    initials={activeConversation.avatarInitials}
                    avatarUrl={activeConversation.avatarUrl}
                    avatarThumbUrl={activeConversation.avatarThumbUrl}
                    size="md"
                    className="w-9 h-9"
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-semibold text-[#171613] dark:text-[#F5EFE3] truncate">
                      {activeConversation.title}
                    </span>
                    <span className="text-[11px] text-[#82796F] dark:text-[#A89F95] truncate">
                      {activeConversation.subtitle} · {activeConversation.handle}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#F6E2E6] dark:bg-[#D98BA5]/20 text-[#171613] dark:text-[#F5EFE3] border border-[#D98BA5]/50 text-[11px] font-mono">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#D98BA5]" />
                    Free Campus Chat
                  </span>
                </div>
              </div>

              {/* Message Viewport */}
              <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-3">
                <div className="text-center my-1">
                  <span className="text-[10px] uppercase tracking-wider text-[#82796F] dark:text-[#A89F95] bg-[#FFFCF7]/75 dark:bg-[#1E1C18] px-3 py-1 rounded-lg border border-[#171613]/10 dark:border-[#F5EFE3]/12">
                    72h Ephemeral Campus Session
                  </span>
                </div>

                {activeConversation.messages.map((msg) => (
                  <MessageBubble
                    key={msg.id || msg.clientId}
                    msg={msg}
                    chatId={activeConversation.id}
                    isDirectChat={getConversationKind(activeConversation) === 'direct'}
                    isEditing={editingMessageId === msg.id}
                    editDraft={editDraft}
                    isSavingEdit={isSavingEdit}
                    isDeleting={deletingMessageId === msg.id}
                    onStartEdit={handleStartEditMessage}
                    onChangeEditDraft={setEditDraft}
                    onSaveEdit={handleSaveEditMessage}
                    onCancelEdit={() => {
                      setEditingMessageId(null);
                      setEditDraft('');
                    }}
                    onDelete={handleDeleteMessageConfirm}
                    onRetry={handleRetry}
                    onOpenLocation={handleOpenLocation}
                    onOpenLightbox={handleOpenLightbox}
                    onViewUserProfile={onViewUserProfile}
                  />
                ))}
                <div ref={messageEndRef} />
              </div>

              {/* Image Upload Progress */}
              {isUploadingImage && (
                <div className="mx-3 mb-2 px-3 py-2 glass-strong rounded-2xl flex flex-col gap-1.5 text-xs text-[#171613] dark:text-[#F5EFE3]">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#C4718E]" />
                      {uploadStatusLabel}
                    </span>
                    <span className="font-mono tabular-nums text-[11px] text-[#82796F] dark:text-[#A89F95]">{uploadProgress}%</span>
                  </div>
                  <div className="w-full h-1 bg-[#E8DDCC] dark:bg-[#2E2B25] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#D98BA5] transition-all duration-200"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Draft Attachment Previews */}
              {attachedImages.length > 0 && (
                <div className="mx-3 mb-2 px-3 py-2 glass-strong rounded-2xl flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 flex-wrap">
                    {attachedImages.map((imgUrl, idx) => (
                      <div key={idx} className="relative w-12 h-12 rounded-xl overflow-hidden border border-[#171613]/12 dark:border-[#F5EFE3]/15">
                        <img src={imgUrl} alt={`Draft attachment ${idx + 1}`} className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => {
                            triggerHaptic('close');
                            setAttachedImages((prev) => prev.filter((_, i) => i !== idx));
                          }}
                          aria-label={`Remove photo ${idx + 1}`}
                          className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-[#171613]/85 text-[#FFFCF7] flex items-center justify-center cursor-pointer"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <span className="font-mono text-[10px] text-[#82796F] dark:text-[#A89F95]">
                    {attachedImages.length}/{MAX_ATTACHMENTS_POST} photos ready
                  </span>
                </div>
              )}

              {attachedLocation && (
                <div className="mx-3 mb-2 px-3 py-2 glass-strong rounded-2xl flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <MapPin className="w-4 h-4 text-[#D98BA5] shrink-0" />
                    <span className="font-medium text-[#171613] dark:text-[#F5EFE3] truncate">Spot: {attachedLocation.name}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('close');
                      setAttachedLocation(null);
                    }}
                    aria-label="Remove location"
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-[#82796F] dark:text-[#A89F95] hover:bg-[#E8DDCC] dark:hover:bg-[#23211C] cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {imageSuccess && !imageError && (
                <div className="mx-3 mb-2 px-3 py-1.5 rounded-xl glass-subtle text-[#171613] dark:text-[#F5EFE3] text-[11px] flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-[#C4718E] shrink-0" />
                  <span>{imageSuccess}</span>
                </div>
              )}

              {imageError && (
                <div className="mx-3 mb-2 px-3 py-2 rounded-xl bg-[#F6E2E6] dark:bg-[#D98BA5]/20 border border-[#D98BA5] text-[#171613] dark:text-[#F5EFE3] text-xs flex items-center justify-between gap-2">
                  <span className="truncate">{imageError}</span>
                  <button type="button" onClick={() => setImageError(null)} className="ml-2 underline shrink-0 cursor-pointer">
                    Dismiss
                  </button>
                </div>
              )}

              {savedLocations.length > 0 && !attachedLocation && (
                <div className="mx-3 mb-1.5 flex items-center gap-1.5 overflow-x-auto scrollbar-none">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-[#82796F] dark:text-[#A89F95] shrink-0">
                    Spots:
                  </span>
                  {savedLocations.slice(0, 5).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        triggerHaptic('tap');
                        setAttachedLocation({
                          id: item.landmarkId || item.id,
                          name: item.displayName,
                          category: item.category,
                          coordinates: item.coordinates,
                          description: item.notes || item.description || item.address,
                          address: item.address,
                          isOffCampus: item.isOffCampus,
                        });
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl glass-subtle text-[11px] font-medium text-[#171613] dark:text-[#F5EFE3] hover:bg-[#F6E2E6]/70 dark:hover:bg-[#D98BA5]/20 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {item.isPinned ? (
                        <Pin className="w-3 h-3 fill-current text-[#D98BA5]" />
                      ) : (
                        <Bookmark className="w-3 h-3 text-[#C4718E]" />
                      )}
                      <span className="max-w-[130px] truncate">{item.displayName}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Floating Frosted Composer with Above-Anchored Mention Suggestions */}
              <form
                onSubmit={handleSend}
                className="relative mx-3 mb-1.5 p-2 rounded-2xl glass-strong flex items-center gap-2"
              >
                <MentionSuggestionsDropdown
                  isOpen={composerMention.isOpen}
                  candidates={composerMention.candidates}
                  isLoading={composerMention.isLoading}
                  selectedIndex={composerMention.selectedIndex}
                  query={composerMention.activeQuery?.query || ''}
                  placement="above"
                  onSelect={composerMention.selectCandidate}
                />

                <input
                  ref={fileInputRef}
                  type="file"
                  accept={IMAGE_UPLOAD_ACCEPT}
                  multiple
                  onChange={handleImageFileChange}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    fileInputRef.current?.click();
                  }}
                  disabled={isUploadingImage || attachedImages.length >= MAX_ATTACHMENTS_POST}
                  aria-label="Attach photo"
                  title={`Attach up to ${MAX_ATTACHMENTS_POST} photos (${IMAGE_UPLOAD_GUIDANCE})`}
                  className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors cursor-pointer shrink-0 disabled:opacity-45 ${
                    attachedImages.length > 0
                      ? 'bg-[#D98BA5] text-[#171613]'
                      : 'bg-[#E8DDCC]/70 dark:bg-[#23211C] text-[#171613] dark:text-[#F5EFE3] hover:bg-[#D98BA5]/30'
                  }`}
                >
                  {isUploadingImage ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    setIsPickerOpen(true);
                  }}
                  aria-label="Share campus location"
                  className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                    attachedLocation
                      ? 'bg-[#D98BA5] text-[#171613]'
                      : 'bg-[#E8DDCC]/70 dark:bg-[#23211C] text-[#171613] dark:text-[#F5EFE3] hover:bg-[#D98BA5]/30'
                  }`}
                >
                  <MapPin className="w-4 h-4" />
                </button>

                <input
                  ref={composerMention.inputRef as React.RefObject<HTMLInputElement>}
                  type="text"
                  value={messageInput}
                  onChange={composerMention.handleValueChange}
                  onClick={composerMention.handleCursorEvent}
                  onKeyUp={composerMention.handleCursorEvent}
                  onKeyDown={(e) => {
                    composerMention.handleKeyDown(e);
                  }}
                  onBlur={() => window.setTimeout(composerMention.dismiss, 160)}
                  placeholder={`Message ${activeConversation.title} (type @ to mention)...`}
                  className="flex-1 bg-transparent px-2 py-2 text-xs md:text-sm text-[#171613] dark:text-[#F5EFE3] placeholder:text-[#82796F] dark:placeholder:text-[#A89F95] focus:outline-none min-w-0"
                />

                <button
                  type="submit"
                  disabled={
                    isUploadingImage ||
                    (!messageInput.trim() && !attachedLocation && attachedImages.length === 0)
                  }
                  aria-label="Send message"
                  className="w-10 h-10 rounded-xl glass-pink text-[#171613] flex items-center justify-center disabled:opacity-40 cursor-pointer shrink-0"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
              <div className="px-4 pb-2 text-[10px] font-mono text-[#82796F] dark:text-[#A89F95]">
                Up to {MAX_ATTACHMENTS_POST} photos · {IMAGE_UPLOAD_GUIDANCE}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-xs text-[#82796F] dark:text-[#A89F95] gap-3">
              <Users className="w-8 h-8 text-[#D98BA5]" />
              <span>Select a conversation or start a direct chat with a coursemate</span>
              <GlassButton variant="pink" size="sm" onClick={() => setIsNewChatModalOpen(true)}>
                Find Coursemate
              </GlassButton>
            </div>
          )}
        </div>
      </GlassCard>

      <Suspense fallback={null}>
        {isNewChatModalOpen && (
          <NewChatModal
            isOpen={isNewChatModalOpen}
            onClose={() => setIsNewChatModalOpen(false)}
            onChatSelected={handleNewChatCreated}
          />
        )}

        {isPickerOpen && (
          <LocationPickerModal
            isOpen={isPickerOpen}
            onClose={() => setIsPickerOpen(false)}
            currentLocation={attachedLocation}
            onSelectLocation={(loc) => setAttachedLocation(loc)}
          />
        )}

        {previewLocation && (
          <LocationViewModal
            location={previewLocation}
            initialShowDirections={openWithDirections}
            onClose={() => {
              setPreviewLocation(null);
              setOpenWithDirections(false);
            }}
          />
        )}

        {lightboxState && (
          <ImageViewerModal
            isOpen={!!lightboxState}
            images={lightboxState.images}
            initialIndex={lightboxState.index}
            title={lightboxState.title}
            onClose={() => setLightboxState(null)}
          />
        )}
      </Suspense>
    </div>
  );
};
