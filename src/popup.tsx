import { type FormEvent, useCallback, useEffect, useState } from "react";
import { P, match } from "ts-pattern";
import packageJson from "../package.json";

import "./style.css";

import { sendToBackground, sendToContentScript } from "@plasmohq/messaging";

import {
  AUTH_FACTOR_TOKEN_REQUIRED_ERROR_MESSAGE,
  BSKY_DOMAIN,
  DOCUMENT_LINK,
  INVALID_IDENTIFIER_OR_PASSWORD_ERROR_MESSAGE,
  MAX_RELOAD_COUNT,
  MESSAGE_NAMES,
  MESSAGE_TYPE,
  RATE_LIMIT_ERROR_MESSAGE,
  STORAGE_KEYS,
  TARGET_URLS_REGEX,
} from "~lib/constants";
import { getMessageWithLink } from "~lib/utils";

function IndexPopup() {
  const [isLoading, setIsLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [reloadCount, setReloadCount] = useState(0);
  const [authFactorToken, setAuthFactorToken] = useState("");
  const [isShowAuthFactorTokenInput, setIsShowAuthFactorTokenInput] =
    useState(false);
  const [message, setMessage] = useState<null | {
    type: (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];
    message: string;
    documentLink?: string;
  }>(null);
  const isShowErrorMessage = message?.type === MESSAGE_TYPE.ERROR;

  const setErrorMessage = (message: string, documentLink?: string) => {
    setMessage({ type: MESSAGE_TYPE.ERROR, message, documentLink });
  };

  const reloadActiveTab = async () => {
    const [{ id: tabId }] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    await chrome.tabs.reload(tabId);
  };

  const saveCredentialsToStorage = async () => {
    await chrome.storage.local.set({
      [STORAGE_KEYS.BSKY_USER_ID]: identifier,
      [STORAGE_KEYS.BSKY_PASSWORD]: password,
    });
  };

  const clearPasswordFromStorage = async () => {
    await chrome.storage.local.remove([STORAGE_KEYS.BSKY_PASSWORD]);
  };

  const saveShowAuthFactorTokenInputToStorage = async (value: boolean) => {
    await chrome.storage.local.set({
      [STORAGE_KEYS.BSKY_SHOW_AUTH_FACTOR_TOKEN_INPUT]: value,
    });
  };

  const loadCredentialsFromStorage = useCallback(async () => {
    chrome.storage.local.get(
      [
        STORAGE_KEYS.BSKY_USER_ID,
        STORAGE_KEYS.BSKY_PASSWORD,
        STORAGE_KEYS.BSKY_SHOW_AUTH_FACTOR_TOKEN_INPUT,
      ],
      (result) => {
        setIdentifier(result[STORAGE_KEYS.BSKY_USER_ID] || "");
        setPassword(result[STORAGE_KEYS.BSKY_PASSWORD] || "");
        setIsShowAuthFactorTokenInput(
          result[STORAGE_KEYS.BSKY_SHOW_AUTH_FACTOR_TOKEN_INPUT] || false,
        );
      },
    );
  }, []);

  const validateForm = () => {
    if (!password && !identifier) {
      setErrorMessage(
        chrome.i18n.getMessage("error_enter_identifier_and_password"),
      );
      return false;
    }
    if (!password) {
      setErrorMessage(chrome.i18n.getMessage("error_enter_password"));
      return false;
    }
    if (!identifier) {
      setErrorMessage(chrome.i18n.getMessage("error_enter_identifier"));
      return false;
    }
    if (isShowAuthFactorTokenInput && !authFactorToken) {
      setErrorMessage(chrome.i18n.getMessage("error_enter_auth_factor_token"));
      return false;
    }
    return true;
  };

  const searchBskyUser = async (e?: FormEvent) => {
    if (e) {
      e.preventDefault();
    }
    if (!validateForm()) {
      return;
    }
    saveCredentialsToStorage();

    const [{ url: currentUrl }] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!Object.values(TARGET_URLS_REGEX).some((r) => r.test(currentUrl))) {
      setErrorMessage(
        chrome.i18n.getMessage("error_invalid_page"),
        DOCUMENT_LINK.PAGE_ERROR,
      );
      return;
    }

    const messageName = match(currentUrl)
      .with(
        P.when((url) => TARGET_URLS_REGEX.FOLLOW.test(url)),
        () => MESSAGE_NAMES.SEARCH_BSKY_USER_ON_FOLLOW_PAGE,
      )
      .with(
        P.when((url) => TARGET_URLS_REGEX.BLOCK.test(url)),
        () => MESSAGE_NAMES.SEARCH_BSKY_USER_ON_BLOCK_PAGE,
      )
      .with(
        P.when((url) => TARGET_URLS_REGEX.LIST.test(url)),
        () => MESSAGE_NAMES.SEARCH_BSKY_USER_ON_LIST_MEMBERS_PAGE,
      )
      .with(
        P.when((url) => TARGET_URLS_REGEX.THREADS.test(url)),
        () => MESSAGE_NAMES.SEARCH_BSKY_USER_ON_THREADS_PAGE,
      )
      .with(
        P.when((url) => TARGET_URLS_REGEX.INSTAGRAM.test(url)),
        () => MESSAGE_NAMES.SEARCH_BSKY_USER_ON_INSTAGRAM_PAGE,
      )
      .run();

    await chrome.storage.local.set({
      [STORAGE_KEYS.BSKY_MESSAGE_NAME]: messageName,
    });

    setMessage(null);
    setIsLoading(true);

    const formattedIdentifier = (
      identifier.includes(".") ? identifier : `${identifier}.${BSKY_DOMAIN}`
    ).replace(/^@/, "");

    try {
      const { session, error } = await sendToBackground({
        name: "login",
        body: {
          identifier: formattedIdentifier,
          password,
          ...(authFactorToken && { authFactorToken: authFactorToken }),
        },
      });
      if (error) {
        if (error.message.includes(AUTH_FACTOR_TOKEN_REQUIRED_ERROR_MESSAGE)) {
          setIsShowAuthFactorTokenInput(true);
          await saveShowAuthFactorTokenInputToStorage(true);
        } else if (error.message.includes(RATE_LIMIT_ERROR_MESSAGE)) {
          setErrorMessage(error.message, DOCUMENT_LINK.RATE_LIMIT_ERROR);
        } else if (
          error.message.includes(INVALID_IDENTIFIER_OR_PASSWORD_ERROR_MESSAGE)
        ) {
          setErrorMessage(
            chrome.i18n.getMessage("error_invalid_identifier_or_password"),
            DOCUMENT_LINK.LOGIN_ERROR,
          );
        } else {
          setErrorMessage(error.message, DOCUMENT_LINK.LOGIN_ERROR);
        }
        return;
      }

      await chrome.storage.local.set({
        [STORAGE_KEYS.BSKY_CLIENT_SESSION]: session,
      });

      const { hasError, message: errorMessage } = await sendToContentScript({
        name: messageName,
      });
      if (hasError) {
        if (errorMessage.includes("Invalid page")) {
          setErrorMessage(errorMessage, DOCUMENT_LINK.PAGE_ERROR);
        } else {
          setErrorMessage(errorMessage, DOCUMENT_LINK.OTHER_ERROR);
        }
        return;
      }

      await clearPasswordFromStorage();
      await saveShowAuthFactorTokenInputToStorage(false);
      window.close();
    } catch (e) {
      if (
        e.message?.includes("Could not establish connection") &&
        reloadCount < MAX_RELOAD_COUNT
      ) {
        setReloadCount((prev) => prev + 1);
        await reloadActiveTab();
        await new Promise((r) => setTimeout(r, 3000));
        await searchBskyUser();
      } else {
        setErrorMessage(
          chrome.i18n.getMessage("error_something_went_wrong"),
          DOCUMENT_LINK.OTHER_ERROR,
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadCredentialsFromStorage();
  }, [loadCredentialsFromStorage]);

  return (
    <div className="px-5 pt-3 pb-4 w-[380px]">
      <h1 className="text-primary dark:text-white text-2xl font-thin flex gap-2 items-center">
        <svg
          className="w-5 h-5"
          xmlns="http://www.w3.org/2000/svg"
          width="48"
          height="48"
          viewBox="0 0 48 48"
        >
          <g
            fill="none"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="4"
          >
            <path
              strokeLinecap="round"
              d="M36 8H13c-3 0-9 2-9 8s6 8 9 8h22c3 0 9 2 9 8s-6 8-9 8H12"
            />
            <path d="M40 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8ZM8 44a4 4 0 1 0 0-8a4 4 0 0 0 0 8Z" />
          </g>
        </svg>
        Sky Follower Bridge{" "}
        <span className="text-sm self-end">v{packageJson.version}</span>
      </h1>
      <form onSubmit={searchBskyUser} className="mt-5">
        <label className="w-full block" htmlFor="identifier">
          <div className="text-sm flex gap-2 items-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-4 h-4"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            {chrome.i18n.getMessage("handle_or_email")}
          </div>
          <input
            type="text"
            name="identifier"
            placeholder={`your-username.${BSKY_DOMAIN}`}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className="input input-bordered input-sm w-full max-w-xs join-item focus:outline-none mt-1"
          />
        </label>
        <label className="mt-3 w-full block" htmlFor="password">
          <div className="text-sm flex gap-2 items-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-4 h-4"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
              />
            </svg>
            <p>
              {chrome.i18n.getMessage("password")}
              <br />
            </p>
          </div>
          <span className="text-xs">
            <span
              // biome-ignore lint/security/noDangerouslySetInnerHtml: <explanation>
              dangerouslySetInnerHTML={{
                __html: getMessageWithLink("recommended_to_use_app_password"),
              }}
            />
          </span>
          <input
            type="password"
            name="password"
            placeholder="abcd-1234-wxyz-7890"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input input-bordered input-sm w-full max-w-xs join-item focus:outline-none mt-1"
          />
        </label>
        {isShowAuthFactorTokenInput && (
          <label className="mt-4 w-full block" htmlFor="authFactorToken">
            <div className="text-sm flex gap-2 items-center mb-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-4 h-4"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 0 1 0 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 0 1 0-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375Z"
                />
              </svg>
              <p>Auth Factor Token</p>
            </div>
            <span className="mt-2">
              A 2FA token has been sent to your email.
            </span>
            <input
              type="text"
              name="authFactorToken"
              placeholder="1234-ABCD"
              value={authFactorToken}
              onChange={(e) => setAuthFactorToken(e.target.value)}
              className="input input-bordered input-sm w-full max-w-xs focus:outline-none mt-1"
            />
          </label>
        )}
        <button
          type="submit"
          className={
            "disabled:text-gray-600 dark:disabled:bg-gray-700 dark:disabled:text-gray-300 mt-4 normal-case btn btn-primary btn-sm w-full"
          }
          disabled={isLoading}
        >
          {isLoading && <span className="w-4 loading loading-spinner" />}
          {isLoading
            ? chrome.i18n.getMessage("finding_bluesky_users")
            : chrome.i18n.getMessage("find_bluesky_users")}
        </button>
        {isShowErrorMessage && (
          <div className="flex gap-2 items-center text-red-600 border border-red-600 p-2 rounded-md mt-2 text-xs">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="stroke-current flex-shrink-0 h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                stroke-linejoin="round"
                strokeWidth="2"
                d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>
              {message.message}
              {message.documentLink && (
                <a
                  href={message.documentLink}
                  target="_blank"
                  rel="noreferrer"
                  className="link ml-2"
                >
                  {chrome.i18n.getMessage("learn_more")}
                </a>
              )}
            </span>
          </div>
        )}
      </form>
    </div>
  );
}

export default IndexPopup;
