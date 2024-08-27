let AWS = require("aws-sdk");
let moment = require("moment");
let uuidv1 = require("uuid/v1");
let MailComposer = require("nodemailer/lib/mail-composer");

//
//	Initialize S3.
//
let s3 = new AWS.S3({
    apiVersion: "2006-03-01",
});

//
//	Initialize SES.
//
let ses = new AWS.SES({
    apiVersion: "2010-12-01",
});

//
//	This lambda will read outgoing emails formated in JSON, convert them
//	in to a raw email, send them using SES, and store them in S3.
//
exports.handler = (event) => {
    //
    //	1.	This JS object will contain all the data within the chain.
    //
    let container = {
        bucket: event.Records[0].s3.bucket.name,
        key: event.Records[0].s3.object.key,
        email: {
            json: {},
            raw: "",
        },
        uuid: uuidv1(),
    };

    //
    //	->	Start the chain.
    //
    load_the_email(container)
        .then(function (container) {
            return extract_data(container);
        })
        .then(function (container) {
            return generate_the_raw_email(container);
        })
        .then(function (container) {
            return send_email(container);
        })
        .then(function (container) {
            return save_raw_email(container);
        })
        .then(function (container) {
            return copy_raw_email(container);
        })
        .then(function (container) {
            return delete_json_email(container);
        })
        .then(function (container) {
            return delete_raw_email(container);
        })
        .then(function (container) {
            return true;
        })
        .catch(function (error) {
            console.error(error);

            return false;
        });
};

//	 _____    _____     ____    __  __   _____    _____   ______    _____
//	|  __ \  |  __ \   / __ \  |  \/  | |_   _|  / ____| |  ____|  / ____|
//	| |__) | | |__) | | |  | | | \  / |   | |   | (___   | |__    | (___
//	|  ___/  |  _  /  | |  | | | |\/| |   | |    \___ \  |  __|    \___ \
//	| |      | | \ \  | |__| | | |  | |  _| |_   ____) | | |____   ____) |
//	|_|      |_|  \_\  \____/  |_|  |_| |_____| |_____/  |______| |_____/
//

//
//	Load the JSON email that triggered this Lambda.
//
function load_the_email(container) {
    return new Promise(function (resolve, reject) {
        console.info("load_the_email");

        //
        //	1.	Set the query.
        //
        let params = {
            Bucket: container.bucket,
            Key: container.key,
        };

        //
        //	->	Execute the query.
        //
        s3.getObject(params, function (error, data) {
            //
            //	1.	Check for internal errors.
            //
            if (error) {
                return reject(error);
            }

            //
            //	2.	Save the email for the next promise.
            //
            container.email.json = JSON.parse(data.Body);

            //
            //	->	Move to the next chain.
            //
            return resolve(container);
        });
    });
}

//
//	Extract all the data necessary to organize the incoming emails.
//
function extract_data(container) {
    return new Promise(function (resolve, reject) {
        console.info("extract_data");

        //
        //	1.	Extract all the information
        //
        let tmp_to = container.email.json.to
            .match(/[A-z0-9-+]{1,30}@[A-z0-9-]{1,65}.[A-z]+/gm)[0]
            .split("@");

        let tmp_from = container.email.json.from
            .match(/[A-z0-9-+]{1,30}@[A-z0-9-]{1,65}.[A-z]+/gm)[0]
            .split("@");

        //
        //	2.	Get the domain name of the receiving end, so we can group
        //		emails by all the domain that were added to SES.
        //
        let to_domain = tmp_to[1];

        //
        //	3.	Based on the email name, we replace all the + characters, that
        //		can be used to organize ones on-line accounts in to /, this way
        //		we can build a S3 patch which will automatically organize
        //		all the email in structured folder.
        //
        let to_account = tmp_to[0].replace(/\+/g, "/");

        //
        //	4.	Get the domain name of the email which in our case will
        //		become the company name.
        //
        let from_domain = tmp_from[1];

        //
        //	5.	Get the name of who sent us the email.
        //
        let from_account = tmp_from[0];

        //
        //	6.	Create a human readable time stamp that matches the format
        //		S3 Provides in its Event.
        //
        let date = moment().format("ddd, DD MMM YYYY HH:MM:SS ZZ");

        //
        //	7.	Create the path where the email needs to be moved
        //		so it is properly organized.
        //
        let path =
            "Sent/" +
            to_domain +
            "/" +
            to_account +
            "/" +
            from_domain +
            "/" +
            from_account +
            "/" +
            date +
            " - " +
            container.email.json.subject +
            "/" +
            "email";

        //
        //	8.	Save the path for the next promise.
        //
        container.path = path;

        //
        //	->	Move to the next chain.
        //
        return resolve(container);
    });
}

//
//	From the JSON file that we loaded in to memory we generate a RAW version
//	that can be used by SES, and later on stored and converted in multiple
//	formats.
//
function generate_the_raw_email(container, callback) {
    return new Promise(function (resolve, reject) {
        console.info("generate_the_raw_email");

        //
        //	1.	Crete the email based on the message object which holds all the
        //		necessary information.
        //
        let mail = new MailComposer(container.email.json);

        //
        //	2.	Take the email and compile it down to its text form for storage.
        //
        mail.compile().build(function (error, raw_message) {
            //
            //	1.	Check if there was an error
            //
            if (error) {
                return reject(error);
            }

            //
            //	2.	Save the raw email so we can save it as is in to S3.
            //
            container.email.raw = raw_message;

            //
            //	->	Move to the next promise
            //
            return resolve(container);
        });
    });
}

//
//	Use the newly generated RAW email and send it using SES.
//
function send_email(container) {
    return new Promise(function (resolve, reject) {
        console.info("send_email");

        //
        //	1.	Create the message
        //
        let params = {
            RawMessage: {
                Data: container.email.raw,
            },
        };

        //
        //	-> Send the email out
        //
        ses.sendRawEmail(params, function (error, data) {
            //
            //	1.	Check if there was an error
            //
            if (error) {
                return reject(error);
            }

            //
            //	->	Move to the next chain
            //
            return resolve(container);
        });
    });
}

//
//	We now save the RAW email to S3 in a temporary folder. We do this because
//	we don't want to create a PUT action in the Sent folder. The reason is
//	that if we were to put the object directly to the destination, it would
//	create a PUT action which would trigger the Convert Lambda. And this is
//	fine. But then then Convert Lambda would save the object with a PUT action
//	which would trigger the Convert Lambda once more, and until infinity.
//
//	To prevent this loop, we make a temporary PUT event with no triggers,
//	and then we copy the object to the final destination, which triggers
//	the Convert action, and once the convert action makes a PUT nothing else
//	happens.
//
function save_raw_email(container) {
    return new Promise(function (resolve, reject) {
        console.info("save_raw_email");

        //
        //	1.	Set the query.
        //
        let params = {
            Bucket: container.bucket,
            Key: "TMP/email_out/raw/" + container.uuid + ".eml",
            Body: container.email.raw,
        };

        //
        //	->	Execute the query.
        //
        s3.putObject(params, function (error, data) {
            //
            //	1.	Check for internal errors.
            //
            if (error) {
                return reject(error);
            }

            //
            //	->	Move to the next chain.
            //
            return resolve(container);
        });
    });
}

//
//	Now that we have our RAW email saved we do a copy event so it will trigger
//	the Conversion Lambda.
//
function copy_raw_email(container) {
    return new Promise(function (resolve, reject) {
        console.info("copy_raw_email");

        //
        //	1.	Set the query.
        //
        let params = {
            Bucket: container.bucket,
            CopySource:
                container.bucket +
                "/TMP/email_out/raw/" +
                container.uuid +
                ".eml",
            Key: container.path,
        };

        //
        //	->	Execute the query.
        //
        s3.copyObject(params, function (error, data) {
            //
            //	1.	Check for internal errors.
            //
            if (error) {
                return reject(error);
            }

            //
            //	->	Move to the next chain.
            //
            return resolve(container);
        });
    });
}

//
//	And before we finish we clean up the environment by deleting the JSON email,
//
function delete_json_email(container) {
    return new Promise(function (resolve, reject) {
        console.info("delete_json_email");

        //
        //	1.	Set the query.
        //
        let params = {
            Bucket: container.bucket,
            Key: container.key,
        };

        //
        //	->	Execute the query.
        //
        s3.deleteObject(params, function (error, data) {
            //
            //	1.	Check for internal errors.
            //
            if (error) {
                return reject(error);
            }

            //
            //	->	Move to the next chain.
            //
            return resolve(container);
        });
    });
}

//
//	And the temporary RAW email.
//
function delete_raw_email(container) {
    return new Promise(function (resolve, reject) {
        console.info("delete_raw_email");

        //
        //	1.	Set the query.
        //
        let params = {
            Bucket: container.bucket,
            Key: "TMP/email_out/raw/" + container.uuid + ".eml",
        };

        //
        //	->	Execute the query.
        //
        s3.deleteObject(params, function (error, data) {
            //
            //	1.	Check for internal errors.
            //
            if (error) {
                return reject(error);
            }

            //
            //	->	Move to the next chain.
            //
            return resolve(container);
        });
    });
}
