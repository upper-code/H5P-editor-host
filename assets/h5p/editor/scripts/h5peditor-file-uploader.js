// Local patch (2026-10-30): check book media allowance before sending a file.
H5PEditor.FileUploader = (function ($, EventDispatcher) {

  /**
   * File Upload API for H5P
   *
   * @class H5PEditor.FileUploader
   * @extends H5P.EventDispatcher
   * @param {Object} field Required for validating the uploaded file
   */
  function FileUploader(field) {
    var self = this;

    // Initialize event inheritance
    EventDispatcher.call(self);

    /**
     * Triggers the actual upload of the file.
     *
     * @param {Blob|File} file
     * @param {string} filename Required due to validation
     */
    function completeUpload(result, release) {
      try {
        self.trigger('uploadComplete', result);
      }
      finally {
        // Release after the widget writes the uploaded path to its params.
        if (release) {
          release();
        }
      }
    }

    function upload(file, filename, release) {
      var formData = new FormData();
      formData.append('file', file, filename);
      formData.append('field', JSON.stringify(field));
      formData.append('contentId', H5PEditor.contentId || 0);

      // Submit the form
      var request = new XMLHttpRequest();
      request.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          self.trigger('uploadProgress', (e.loaded / e.total));
        }
      };
      request.onload = function () {
        var result;
        var uploadComplete = {
          error: null,
          data: null
        };

        try {
          result = JSON.parse(request.responseText);
        }
        catch (err) {
          H5P.error(err);
          // Add error data to event object
          uploadComplete.error = H5PEditor.t('core', 'fileToLarge');
        }

        if (result !== undefined && result !== null && typeof result === 'object') {
          if (result.error !== undefined) {
            uploadComplete.error = result.error;
          }
          if (result.success === false) {
            uploadComplete.error = (result.message ? result.message : H5PEditor.t('core', 'unknownFileUploadError'));
          }
        }

        if (result === null || (result !== undefined && typeof result !== 'object')) {
          uploadComplete.error = H5PEditor.t('core', 'unknownFileUploadError');
        }

        if (uploadComplete.error === null) {
          // No problems, add response data to event object
          uploadComplete.data = result;
        }

        // Allow the widget to process the result
        completeUpload(uploadComplete, release);
      };

      request.onerror = request.onabort = request.ontimeout = function () {
        completeUpload({
          error: H5PEditor.t('core', 'unknownFileUploadError'),
          data: null
        }, release);
      };

      request.open('POST', H5PEditor.getAjaxUrl('files'), true);
      request.send(formData);
      if (!release) {
        self.trigger('upload');
      }
    }

    self.upload = function (file, filename) {
      // The host can refuse a file before any media bytes leave the browser.
      // An upstream embedding without the hook retains the ordinary upload.
      if (typeof H5PEditor.beforeMediaUpload !== 'function') {
        upload(file, filename);
        return;
      }
      self.trigger('upload');
      Promise.resolve().then(function () {
        return H5PEditor.beforeMediaUpload(file);
      }).then(function (release) {
        try {
          upload(file, filename, release);
        }
        catch (error) {
          completeUpload({ error: error.message, data: null }, release);
        }
      }, function (error) {
        completeUpload({ error: error.message, data: null });
      });
    };

    /**
     * Upload the list of file objects.
     * TODO: Future improvement, iterate for multiple files
     *
     * @param {File[]} files
     */
    self.uploadFiles = function (files) {
      self.upload(files[0], files[0].name);
    };

    /**
     * Open the file selector and trigger upload upon selecting file.
     */
    self.openFileSelector = function () {
      // Create a file selector
      const input = document.createElement('input');
      input.type = 'file';
      input.setAttribute('accept', determineAllowedMimeTypes());
      input.style='display:none';
      input.addEventListener('change', function () {
        // When files are selected, upload them
        self.uploadFiles(this.files);
        document.body.removeChild(input);
      });

      document.body.appendChild(input);
      // Open file selector
      input.click();
    };

    /**
     * Determine allowed file mimes. Used to make it easier to find and
     * select the correct file.
     *
     * @return {string}
     */
    const determineAllowedMimeTypes = function () {
      if (field.mimes) {
        return field.mimes.join(',');
      }

      switch (field.type) {
        case 'image':
          return 'image/jpeg,image/png,image/gif';
        case 'audio':
          return 'audio/mpeg,audio/x-wav,audio/ogg,audio/mp4';
        case 'video':
          return 'video/mp4,video/webm,video/ogg';
      }
    }
  }

  // Extends the event dispatcher
  FileUploader.prototype = Object.create(EventDispatcher.prototype);
  FileUploader.prototype.constructor = FileUploader;
  FileUploader.supportsMediaUploadPreflight = true;

  return FileUploader;
})(H5P.jQuery, H5P.EventDispatcher);
