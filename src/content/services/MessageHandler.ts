import { ICommentInserter } from './interfaces/ICommentInserter';
import { IPostDetector } from './interfaces/IPostDetector';
import { CommentDisplay } from '../ui/CommentDisplay';

/**
 * MessageHandler - Service for handling extension messages
 */
export class MessageHandler {
  private commentDisplay: CommentDisplay;
  
  constructor(
    private commentInserter: ICommentInserter,
    private postDetector: IPostDetector
  ) {
    this.commentDisplay = new CommentDisplay();
  }
  
  /**
   * Set up message listener
   */
  setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      console.log('⭐ MessageHandler: Received message:', message);
      
      if ('type' in message) {
        switch (message.type) {
          case 'COMMENT_GENERATED':
            this.handleCommentGenerated(message.payload);
            sendResponse({ success: true });
            break;
            
          case 'INSERT_COMMENT':
            const insertResult = this.commentInserter.insertComment(
              message.payload.comment, 
              message.payload.elementId
            );
            sendResponse({ success: insertResult });
            break;
            
          case 'GET_LINKEDIN_POST_STATUS':
            // Trigger fresh scans
            const postsCount = this.postDetector.scanForLinkedInPosts();
            // Get number of processed comment fields
            const commentFieldsCount = this.postDetector.getCommentFieldsCount();
            
            sendResponse({ 
              success: true,
              postsDetected: postsCount,
              commentFieldsDetected: commentFieldsCount,
              url: window.location.href,
              isLinkedInPage: this.isLinkedInPage()
            });
            break;
          
          default:
            sendResponse({ error: 'Unknown message type' });
        }
      }
      
      return true; // Keep the message channel open for async response
    });
    
    console.log('⭐ MessageHandler: Message listener set up');
  }
  
  /**
   * Check if the current page is a LinkedIn page
   */
  private isLinkedInPage(): boolean {
    const hostname = window.location.hostname;
    return hostname.includes('linkedin.com');
  }
  
  /**
   * Handle generated comments
   */
  private handleCommentGenerated(payload: any): void {
    console.log('⭐ MessageHandler: Comment generated:', payload);
    
    // Check if we have comments and a field ID
    if (!payload.comments || !payload.fieldId) {
      console.warn('⚠️ MessageHandler: Invalid payload for comment generation:', payload);
      return;
    }
    
    // Show the comments UI
    this.commentDisplay.showCommentsUI(payload.comments, payload.fieldId);
  }
}