import type { mrkdwn, plainText } from '@/harness';

type SlackText = ReturnType<typeof mrkdwn | typeof plainText>;

interface SlackButtonElement {
  action_id?: string;
  confirm?: SlackConfirm;
  style?: 'danger' | 'primary';
  text: ReturnType<typeof plainText>;
  type: 'button';
  value?: string;
}

interface SlackTextInputElement {
  action_id: string;
  initial_value?: string;
  max_length?: number;
  multiline?: boolean;
  placeholder?: ReturnType<typeof plainText>;
  type: 'plain_text_input';
}

interface SlackSelectOption {
  text: ReturnType<typeof plainText>;
  value: string;
}

interface SlackSelectElement {
  action_id: string;
  initial_option?: SlackSelectOption;
  options: SlackSelectOption[];
  placeholder?: ReturnType<typeof plainText>;
  type: 'static_select';
}

interface SlackConfirm {
  confirm: ReturnType<typeof plainText>;
  deny: ReturnType<typeof plainText>;
  text: ReturnType<typeof mrkdwn>;
  title: ReturnType<typeof plainText>;
}

export type SlackBlock =
  | {
      type: 'actions';
      elements: SlackButtonElement[];
    }
  | {
      accessory?: SlackButtonElement;
      text: ReturnType<typeof mrkdwn>;
      type: 'section';
    }
  | {
      elements: SlackText[];
      type: 'context';
    }
  | {
      type: 'divider';
    }
  | {
      text: ReturnType<typeof plainText>;
      type: 'header';
    }
  | {
      block_id: string;
      element: SlackSelectElement | SlackTextInputElement;
      hint?: ReturnType<typeof plainText>;
      label: ReturnType<typeof plainText>;
      optional?: boolean;
      type: 'input';
    };

export interface SlackHomeView {
  blocks: SlackBlock[];
  type: 'home';
}

export interface SlackModalView {
  blocks: SlackBlock[];
  callback_id: string;
  close: ReturnType<typeof plainText>;
  private_metadata?: string;
  submit?: ReturnType<typeof plainText>;
  title: ReturnType<typeof plainText>;
  type: 'modal';
}
