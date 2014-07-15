#!/usr/bin/env node

var request = require("request");
var defer = require('promised-io/promise').defer;
var when = require('promised-io/promise').when;
var All = require('promised-io/promise').all;
var argv = require("optimist").argv;

if (!argv.user &&  !process.env.OVIRT_API_USER) {
	throw new Error("API Username Required (--user)");
}

if (!argv.password && !process.env.OVIRT_API_PASSWORD) {
	throw new Error("API Password Required (--password)");
}

if (!argv.url && !process.env.OVIRT_API_URL) {
	throw new Error("URL of API host is required (--url)");
}

api_host = argv.url || process.env.OVIRT_API_URL;

var auth = {
	user: argv.user || process.env.OVIRT_API_USER,
	pass: argv.password || process.env.OVIRT_API_PASSWORD
}

function getVMs(query) {
	var def = new defer();

	request({
		url: api_host + "/api/vms" + (query?("?search="+query):""),
		auth: auth,
		headers: {
			accept: "application/json"
		},
		strictSSL: false,
		json: true
	}, function(err,response,body){
    //            console.log("Body: ", body);
		if (err) {
			console.log("Err: ", err);
			return;
		}
		def.resolve(body.vm);
	});	
	
	return def.promise;
}

function getNICs(vm){
	var def= new defer();
	var nicsMeta = vm.link.filter(function(link){
		return link.rel=="nics";
	})[0]

	var nics = [];

	request({
		url: api_host + "/" + nicsMeta.href,
		auth: auth,
		headers: {
                        accept: "application/json"
                },
                strictSSL: false,
                json: true
        }, function(err,response,rnics){
		rnics = rnics.nics;
                if (err) {
                        console.log("Err: ", err);
                        return;
                }

		if (response.statusCode>=400){
			console.log("getNICs statusCode: ", response.statusCode);
			def.reject(response.statusCode);
			
		}
		if (!rnics) { return def.resolve([]); }

		def.resolve(rnics);
        });
	return def.promise;
}



function getVMTags(vm){
	var def= new defer();
	var tagsMeta = vm.link.filter(function(link){
		return link.rel=="tags";
	})[0]

	var tags = [];

	request({
		url: api_host + "/" + tagsMeta.href,
		auth: auth,
		headers: {
                        accept: "application/json"
                },
                strictSSL: false,
                json: true
        }, function(err,response,rtags){
		rtags = rtags.tag;
                if (err) {
                        console.log("Err: ", err);
                        return;
                }

		if (response.statusCode>=400){
			console.log("getVMTags statusCode: ", response.statusCode);
			def.resove(rtags);
			
		}
		if (!rtags) { return def.resolve([]); }
		var parentTagDefs = []
		tags.push(rtags);
		rtags.forEach(function(tag) {
			parentTagDefs.push(when(getParentTag(tag,vm, api_host + tagsMeta.href), function(parentTag){
				tag.parent=parentTag
				tags.push(tag);
				return tag;
			}));
		});

		return when(All(parentTagDefs), function(){
			def.resolve(rtags);
		});
        });
	return def.promise;
}

function getParentTag(tag,vm,baseLink) {
	var def = new defer();
	if (tag && tag.parent && tag.parent.tag && tag.parent.tag.id){
		var def = new defer();
		//console.log("Get Parent: ", api_host + "/api/tags/" + tag.parent.tag.id);
		request({
			url: baseLink + "/" + tag.parent.tag.id,
			auth: auth,
			headers: {
				accept: "application/json"
	                },
			strictSSL: false,
			json: true
		}, function(err,response,ptag){
	                if (response.statusCode>=400){
				def.resove(null);
				//def.reject(response.statusCode);
               		}
			if (err) {
				console.log("Err: ", err);
				def.resolve(null);
			}
			def.resolve(ptag);

		});	
	}else{
		def.resolve(null);		
	}
	return def.promise;
}

var inventory = {}

function addVMToInventoryGroup(vm) {
	tags = vm.tags;
	var project,env,service;

	tags.forEach(function(tag){
		if (tag.name && tag.parent && tag.parent.name){
			switch(tag.parent.name.toLowerCase()){
				case "project":
					project=tag.name;
					break;
				case "environment":
					env = tag.name;
					break;
				case "service":
					service=tag.name;
					break;
			}
		}
	});

	var groupName = [project,service,env].filter(function(x){ return !!x; });

	if (groupName.length>0){
		groupName = groupName.join("_");
	}else{
		groupName="ungrouped" 
	}

	if (!inventory[groupName]) {
		inventory[groupName]=[];
	}

	inventory[groupName].push(vm);

}

function listGroups(inventory){
	var out = {
		"_meta":{
			"hostvars": {

			}
		}
	}

	Object.keys(inventory).forEach(function(group){
	//	console.log("[" + group + "]");
		out[group] = {hosts: inventory[group].map(function(vm){
			return vm.name;
			/*
			if (vm.name.match(".cid-mgmt")) {
				return vm.name; 
			}else{
				return vm.name + ".cid-mgmt"
			}
			*/
		})};

	});

	console.log(JSON.stringify(out,null,4));
}

if (argv.list) {
	when(getVMs(""), function(vms){
		var tagDefs=[];
		if (vms && vms.forEach) {
			vms.forEach(function(vm){
				tagDefs.push(when(getVMTags(vm), function(tags){
					vm.tags = tags;	
				}));
			});
	
			return when(All(tagDefs), function(){
				vms.forEach(addVMToInventoryGroup)
			
				listGroups(inventory);
			});
		}else{
			console.log("No VMs: ", vms);
			throw Error("no vms");	
		}
	}, function(err){
		console.log("err retrieving vms: ", err);
		return err;
	});
}

if (argv.getVMDetail) {
	when(getVMs("name="+argv.getVMDetail), function(vms){
		if (!vms || vms.length<1){
			console.log("VM Not found");
			process.exit(1);
		}
		vm=vms[0];
		var nicDefs=[];
		when(getNICs(vm), function(nics){
			vm.nics= nics;	
			console.log(JSON.stringify(vm,null,4));
		});
	});
}



if (argv.isReady) {
        console.log("Checking for readiness state of ", argv.isReady);
	when(getVMs("name="+argv.isReady), function(vms){
		if (!vms || vms.length<1){	
			console.log("VM " + argv.isReady+ " was not found.");
			process.exit(1);
                }else{
			var vm = vms[0]
			if (vm.status && vm.status.state && vm.status.state!="image_locked"){
				console.log("VM State: ", vm.status.state);
				process.exit(0);
			}else{
				console.log("VM Not in ready state: \n",JSON.stringify(vm.status));
				process.exit(1);
			}
		}
	});

}

if (argv.isUpAndReady) {
        console.log("Checking for readiness state of ", argv.isUpAndReady);
	when(getVMs("name="+argv.isUpAndReady), function(vms){
		if (!vms || vms.length<1){	
			console.log("VM " + argv.isUpAndReady+ " was not found.");
			process.exit(1);
                }else{
			var vm = vms[0]
			if (vm.status && vm.status.state && vm.status.state=="up" && vm.guestInfo){
				console.log("VM State: ", vm.status.state, vm.guestInfo);
				process.exit(0);
			}else{
				console.log("VM is not ready or does not yet have guest agent infon",JSON.stringify(vm));
				process.exit(1);
			}
		}
	});

}



if (argv.host) {
	console.log("{}");
}



if (argv.status) {
	when(getVMs("name="+argv.status ), function(vms){
		if (!vms || vms.length<1){	
			console.log("VM " + argv.status + " was not found.");
			process.exit(1);
                }else{
			console.log(JSON.stringify(vms[0],null,4))
			process.exit(0);
		}
	});

}



